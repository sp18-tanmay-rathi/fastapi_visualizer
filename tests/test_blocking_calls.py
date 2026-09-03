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


# --- the dispatcher must never raise ---------------------------------------
#
# `_dispatch` is the single process-wide `sys.addaudithook` callback. An
# exception escaping it is raised inside whatever audited call happened to
# trigger it — a plain `open()` somewhere in application code, on whatever
# thread ran it — so this is the one function in the package where an unhandled
# error is worst. It used to build its snapshot with `tuple(_ACTIVE)`, which
# races with install/uninstall on another thread.


def test_dispatch_survives_concurrent_install_and_uninstall():
    """The reviewer's repro, as a test.

    A tight install/uninstall loop on one thread while the audit hook fires on
    another. Iterating the WeakSet live raised
    `RuntimeError: Set changed size during iteration` — measured 56 times in
    two seconds.
    """
    import threading

    import fastapi_visualizer.blockingcalls as bc

    stop = threading.Event()
    escaped: list[BaseException] = []
    loop_tid = threading.get_ident()

    churn = bc.BlockingCallDetector()
    resident = bc.BlockingCallDetector()
    resident.install(loop_tid)

    def mutate():
        while not stop.is_set():
            churn.install(loop_tid)
            churn.uninstall()

    def fire():
        while not stop.is_set():
            try:
                bc._dispatch("open", ("/tmp/x", "r", 0))
            except BaseException as exc:  # noqa: BLE001 - the whole point
                escaped.append(exc)

    threads = [threading.Thread(target=mutate, daemon=True),
               threading.Thread(target=fire, daemon=True)]
    for t in threads:
        t.start()
    stop.wait(2.0)
    stop.set()
    for t in threads:
        t.join(timeout=2)

    resident.uninstall()
    churn.uninstall()
    assert not escaped, f"{len(escaped)} exception(s) escaped the audit hook: {escaped[:3]}"


def test_dispatch_swallows_a_detector_that_raises():
    """One broken detector must not take the audited call down with it."""
    import fastapi_visualizer.blockingcalls as bc

    class Exploding:
        def _hook(self, event, args):
            raise RuntimeError("boom")

    boom = Exploding()
    with bc._HOOK_LOCK:
        bc._ACTIVE.add(boom)
        bc._refresh_dispatch()
    try:
        bc._dispatch("open", ("/tmp/x", "r", 0))  # must not raise
    finally:
        with bc._HOOK_LOCK:
            bc._ACTIVE.discard(boom)
            bc._refresh_dispatch()


def test_the_snapshot_does_not_pin_a_dropped_detector():
    """Weak references in the snapshot, so a dropped app is still collectable."""
    import gc
    import threading
    import weakref as _wr

    import fastapi_visualizer.blockingcalls as bc

    d = bc.BlockingCallDetector()
    d.install(threading.get_ident())
    ref = _wr.ref(d)
    del d
    gc.collect()
    assert ref() is None, "the dispatch snapshot kept a dead detector alive"
    # and dispatching over a snapshot holding a dead ref is still safe
    bc._dispatch("open", ("/tmp/x", "r", 0))


async def test_an_unattributable_blocking_call_is_not_reported(client_for):
    """A blocking read with no frame of the user's code on the stack.

    Found on a real Django project. Django imports its URLconf lazily, on the
    first request to arrive; that pulled in reportlab, which reads
    ~/.reportlab_settings at import time. A genuine blocking read on the loop
    thread — but charged to a request that merely happened to be first, never
    repeated, and reported with `qualname=None` because no in-root frame was
    open. An alarming red chip with nothing actionable behind it.

    `_is_import` cannot catch it: that inspects the PATH being opened, and a
    dotfile in the home directory looks like ordinary application I/O.
    """
    app = FastAPI()
    probe = os.path.join(tempfile.gettempdir(), "viz_unattributed_probe.txt")
    with open(probe, "w") as fh:
        fh.write("x")

    @app.get("/via-library")
    async def via_library():
        # Stand-in for library-internal work: the read happens while no frame
        # of the app's own code is on the stack, which is what an import-time
        # read inside a third-party package looks like.
        mon = app.state._viz["monitor"]
        saved = mon._active
        mon._active = None  # no in-root frame open
        try:
            with open(probe) as fh:
                fh.read()
        finally:
            mon._active = saved
        return {"ok": True}

    visualize(app, enabled=True, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/via-library")).status_code == 200

    calls = [e for e in collector.snapshot() if e.kind == "blocking_call"]
    assert not calls, (
        "reported a blocking call it cannot attribute to any frame: "
        f"{[(e.extra.get('category'), e.extra.get('qualname')) for e in calls]}"
    )


async def test_an_attributable_blocking_call_is_still_reported(client_for):
    """The guard above must not silence the case the detector exists for."""
    app = FastAPI()
    probe = os.path.join(tempfile.gettempdir(), "viz_attributed_probe.txt")
    with open(probe, "w") as fh:
        fh.write("x")

    @app.get("/direct")
    async def direct():
        with open(probe) as fh:  # inside the app's own frame
            return {"bytes": len(fh.read())}

    visualize(app, enabled=True, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/direct")).status_code == 200

    calls = [e for e in collector.snapshot() if e.kind == "blocking_call"]
    assert calls, "a blocking read inside the app's own frame went unreported"
    assert any(e.extra.get("category") == "file" for e in calls)
    assert any(e.extra.get("qualname") for e in calls), (
        "reported with no frame — the guard should have suppressed it instead"
    )
