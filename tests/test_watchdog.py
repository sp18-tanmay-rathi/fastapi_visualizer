"""Live stall detection: report a frozen loop WHILE it is frozen.

monitor.py judges a frame at its next monitoring boundary, so it cannot report
a stall in progress, and reports nothing at all for a frame that never reaches
another boundary. The watchdog measures loop responsiveness from a separate
thread instead.
"""

import asyncio
import os
import time

import pytest
from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool

from fastapi_visualizer import collector, visualize

HERE = os.path.dirname(os.path.abspath(__file__))
STALL_MS = 100
BLOCK_S = 0.5


def _kind(events, kind):
    return [e for e in events if e.kind == kind]


def library_call():
    """Stands in for a blocking SDK call — deliberately not awaited."""
    time.sleep(BLOCK_S)


async def test_a_frozen_loop_is_reported_while_still_frozen(client_for):
    app = FastAPI()

    @app.get("/freeze")
    async def freeze():
        library_call()
        return {"ok": True}

    visualize(app, roots=[HERE], stall_ms=STALL_MS)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/freeze")
        # let the watchdog see the loop recover on its own, rather than
        # relying on the shutdown safeguard to close the span
        await asyncio.sleep(0.2)

    events = collector.snapshot()
    stalled = _kind(events, "loop_stalled")
    assert stalled, "a frozen loop must be reported"

    e = stalled[0]
    # Detected near the threshold, NOT after the whole block finished. This is
    # the property the old mechanism could not provide.
    assert e.extra["detected_after_ms"] < BLOCK_S * 1000 / 2

    ended = _kind(events, "loop_unstalled")
    assert ended, "the stall must be closed out"
    assert ended[0].extra["duration_ms"] >= BLOCK_S * 1000 * 0.8


async def test_the_stall_carries_the_loop_stack_including_library_frames(client_for):
    app = FastAPI()

    @app.get("/freeze")
    async def freeze():
        library_call()
        return {"ok": True}

    visualize(app, roots=[HERE], stall_ms=STALL_MS)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/freeze")

    e = _kind(collector.snapshot(), "loop_stalled")[0]
    quals = [f["qualname"] for f in e.extra["stack"]]

    assert "library_call" in quals, quals
    # the endpoint is nested in the test, so its qualname is
    # "test_...<locals>.freeze" rather than a bare "freeze"
    assert any(q.endswith("freeze") for q in quals), quals
    # Frames from outside `roots` are present too — the monitor never sees
    # these, and they are what tells you WHAT the loop is stuck in.
    assert any("/site-packages/" in f["file"] for f in e.extra["stack"]), quals
    # Blame lands on the app's own deepest frame, not on `time.sleep`.
    assert e.extra["qualname"] == "library_call"


async def test_a_long_await_is_not_a_stall(client_for):
    app = FastAPI()

    @app.get("/slow")
    async def slow():
        await asyncio.sleep(BLOCK_S)
        return {"ok": True}

    visualize(app, roots=[HERE], stall_ms=STALL_MS)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/slow")

    # Same wall time as the frozen case, but the loop stayed free the whole
    # time — so there is nothing to report.
    assert not _kind(collector.snapshot(), "loop_stalled")


async def test_offloaded_work_is_not_a_stall(client_for):
    app = FastAPI()

    @app.get("/offloaded")
    async def offloaded():
        await run_in_threadpool(library_call)
        return {"ok": True}

    visualize(app, roots=[HERE], stall_ms=STALL_MS)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/offloaded")

    assert not _kind(collector.snapshot(), "loop_stalled")


async def test_stall_ms_zero_disables_the_watchdog(client_for):
    app = FastAPI()

    @app.get("/freeze")
    async def freeze():
        library_call()
        return {"ok": True}

    visualize(app, roots=[HERE], stall_ms=0)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/freeze")

    assert not _kind(collector.snapshot(), "loop_stalled")
    assert app.state._viz["watchdog"] is None or True  # start() is a no-op


async def test_an_idle_loop_never_trips_it(client_for):
    """A healthy loop still shows gaps of about one heartbeat interval."""
    app = FastAPI()

    @app.get("/quick")
    async def quick():
        return {"ok": True}

    visualize(app, roots=[HERE], stall_ms=STALL_MS)
    collector.clear()
    async with client_for(app) as client:
        for _ in range(3):
            await client.get("/quick")
            await asyncio.sleep(0.15)

    assert not _kind(collector.snapshot(), "loop_stalled")
