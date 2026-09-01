"""Catch a blocking call by WHAT IT IS, not by how long it took.

The gap this closes: a database or file call that answers in a millisecond is
the same defect as one that takes a second — the loop thread waited on the
outside world instead of yielding — but no duration threshold will ever see it.
"""

import asyncio
import os
import sqlite3
import threading
import tempfile

import pytest
from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool

from fastapi_visualizer import collector, visualize

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(tempfile.gettempdir(), "viz_blocking_probe.txt")


@pytest.fixture(scope="module", autouse=True)
def probe_file():
    with open(PROBE, "w") as f:
        f.write("hello")
    yield
    try:
        os.remove(PROBE)
    except OSError:
        pass


def _calls(events):
    return [e for e in events if e.kind == "blocking_call"]


def _categories(events):
    return {e.extra["category"] for e in _calls(events)}


async def test_a_fast_file_read_on_the_loop_is_caught(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        with open(PROBE) as f:
            return {"n": len(f.read())}

    # slow_ms deliberately high: nothing here is remotely slow, which is the
    # entire point — a stopwatch cannot find this.
    visualize(app, roots=[HERE], slow_ms=5000)
    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/w")).status_code == 200

    events = collector.snapshot()
    assert "file" in _categories(events), _categories(events)
    assert not [e for e in events if e.kind == "loop_blocked"], "too fast to time"
    assert any(PROBE in e.extra["detail"] for e in _calls(events))


async def test_a_fast_database_connect_on_the_loop_is_caught(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        con = sqlite3.connect(":memory:")
        con.execute("select 1").fetchone()
        con.close()
        return {"ok": True}

    visualize(app, roots=[HERE], slow_ms=5000)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    assert "database" in _categories(collector.snapshot())


async def test_the_same_call_on_a_worker_thread_is_not_reported(client_for):
    """Blocking on a worker is correct by design — that is what it is for."""
    app = FastAPI()

    @app.get("/w")
    async def w():
        def work():
            with open(PROBE) as f:
                return len(f.read())

        return {"n": await run_in_threadpool(work)}

    visualize(app, roots=[HERE], slow_ms=5000)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    assert not _calls(collector.snapshot()), _categories(collector.snapshot())


async def test_a_clean_async_request_reports_nothing(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.01)
        return {"ok": True}

    visualize(app, roots=[HERE], slow_ms=5000)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    assert not _calls(collector.snapshot())


async def test_imports_are_not_mistaken_for_application_io(client_for):
    """A lazy import opens a .py file on the loop inside whatever request
    triggered it. That is the interpreter's bookkeeping, not the app's I/O."""
    app = FastAPI()

    @app.get("/w")
    async def w():
        import base64  # noqa: F401  (may or may not be a fresh import)

        return {"ok": True}

    visualize(app, roots=[HERE], slow_ms=5000)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    for e in _calls(collector.snapshot()):
        assert not e.extra["detail"].endswith(".py"), e.extra["detail"]


async def test_it_can_be_turned_off(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        with open(PROBE) as f:
            return {"n": len(f.read())}

    visualize(app, roots=[HERE], slow_ms=5000, detect_blocking_calls=False)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    assert not _calls(collector.snapshot())


async def test_repeats_within_one_request_are_collapsed(client_for):
    """A handler reading the same file in a loop must not flood the buffer."""
    app = FastAPI()

    @app.get("/w")
    async def w():
        for _ in range(25):
            with open(PROBE) as f:
                f.read()
        return {"ok": True}

    visualize(app, roots=[HERE], slow_ms=5000)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    same = [e for e in _calls(collector.snapshot()) if PROBE in e.extra["detail"]]
    assert len(same) == 1, f"expected one report, got {len(same)}"


async def test_a_long_source_path_is_still_recognised_as_an_import(client_for):
    """The import filter must run on the full path, not a truncated one.

    Detail strings are capped for display. Filtering the capped string meant a
    path longer than the cap lost its ".py" suffix and was reported as
    application I/O — a false positive on a completely clean request.
    """
    from fastapi_visualizer.blockingcalls import BlockingCallDetector

    long_dir = "/" + "/".join("segment%02d" % i for i in range(30))
    long_py = long_dir + "/module.py"
    assert len(long_py) > 120, "the path must exceed the display cap"
    assert BlockingCallDetector._is_import(long_py)


def test_the_dedup_set_is_bounded():
    """It is keyed per REQUEST, so it grows forever without a cap.

    One entry per blocking call per request, never released — a slow leak over
    a long development session, which is exactly how this tool is used.
    """
    from fastapi_visualizer.blockingcalls import _MAX_SEEN, BlockingCallDetector

    d = BlockingCallDetector()
    d.enabled = True
    d.loop_tid = threading.get_ident()

    # feed more distinct (trace, category, detail) keys than the cap allows
    for i in range(_MAX_SEEN + 500):
        d._seen.add((f"trace{i}", "file", f"/tmp/{i}"))
    assert len(d._seen) > _MAX_SEEN

    # the hook bails out unless a request is in flight, so give it one
    from fastapi_visualizer import identity

    token = identity.trace_id_var.set("deadbeefdeadbeef")
    try:
        # the next real report trims it rather than growing without limit
        d._hook("open", (PROBE, "r", 0))
    finally:
        identity.trace_id_var.reset(token)

    assert len(d._seen) <= _MAX_SEEN
