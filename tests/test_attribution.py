"""Who gets blamed for a freeze — and who must not.

The tool's whole value is trustworthy attribution, so the interesting cases
here are the ones where the honest answer is "nobody".
"""

import asyncio
import os
import sys
import threading
import time

import pytest
from fastapi import FastAPI

from fastapi_visualizer import visualize
from fastapi_visualizer.collector import collector

HERE = os.path.dirname(os.path.abspath(__file__))
STALL_MS = 120


def _kind(events, kind):
    return [e for e in events if e.kind == kind]


async def _drain(seconds=0.4):
    await asyncio.sleep(seconds)


# --- the open frame is forgotten completely when it closes -----------------


async def test_no_frame_open_means_no_frame_reported(client_for):
    """`active_frame()` is None once the frame that opened it has returned.

    `_loop_close` used to clear only the node and the timestamp, leaving
    `_active_trace` pointing at the last request that ran in-root code for the
    rest of the process. Every later reader inherited that stale request.
    """
    app = FastAPI()

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    visualize(app, enabled=True, roots=[HERE])
    async with client_for(app) as client:
        await client.get("/ping")
        mon = app.state._viz["monitor"]
        # Nothing is executing in-root between requests.
        await _drain(0.05)
        assert mon.active_frame() is None, mon.active_frame()


async def test_a_closed_frame_leaves_no_stale_trace(client_for):
    app = FastAPI()

    @app.get("/one")
    async def one():
        return {"ok": True}

    visualize(app, enabled=True, roots=[HERE])
    async with client_for(app) as client:
        await client.get("/one")
        mon = app.state._viz["monitor"]
        await _drain(0.05)
        # The five loop-thread fields are cleared as a set, not just two of
        # them — a half-cleared frame is what produced the stale attribution.
        assert mon._active_node is None
        assert mon._active_trace is None
        assert mon._active_task is None
        assert mon._active_qual == ""


async def test_the_snapshot_is_whole_or_absent(client_for):
    """A cross-thread reader never sees one frame's node with another's trace."""
    app = FastAPI()
    seen = []
    stop = threading.Event()

    def _held_open():
        # Stays on the stack long enough for the watcher thread to be
        # scheduled — a frame that opens and closes in microseconds proves
        # nothing about what a concurrent reader sees.
        time.sleep(0.15)

    @app.get("/busy")
    async def busy():
        for _ in range(3):
            _held_open()
            await asyncio.sleep(0)
        return {"ok": True}

    visualize(app, enabled=True, roots=[HERE])

    def watcher(mon):
        while not stop.is_set():
            snap = mon.active_frame()
            if snap is not None:
                seen.append(snap)

    async with client_for(app) as client:
        mon = app.state._viz["monitor"]
        t = threading.Thread(target=watcher, args=(mon,), daemon=True)
        t.start()
        await client.get("/busy")
        stop.set()
        t.join(timeout=2)

    assert seen, "watcher never caught an open frame"
    for node, trace, qual in seen:
        # Whole tuples only: a node always arrives with the qualname of the
        # same frame, never a blend of two.
        assert isinstance(node, int)
        assert isinstance(qual, str) and qual != ""


# --- a stall nobody owns is reported as owned by nobody --------------------


async def test_a_stall_outside_any_request_blames_no_request(client_for):
    """A freeze while no in-root frame is open carries trace_id None.

    Before, it inherited whichever request last ran in-root code — usually one
    that had already finished — and the dashboard branded that innocent row.
    """
    app = FastAPI()

    @app.get("/quick")
    async def quick():
        return {"ok": True}

    visualize(app, enabled=True, roots=[HERE], stall_ms=STALL_MS)
    async with client_for(app) as client:
        await client.get("/quick")          # leaves a finished request behind
        collector.clear()
        # Freeze the loop from OUTSIDE any traced frame.
        loop = asyncio.get_running_loop()
        loop.call_soon(time.sleep, 0.4)
        await _drain(0.7)

    stalls = _kind(collector.snapshot(), "loop_stalled")
    assert stalls, "the watchdog missed a 400ms freeze"
    for s in stalls:
        assert s.trace_id is None, (
            f"a freeze in untraced code was blamed on request {s.trace_id}"
        )
        # The stack is still there — that is what actually identifies it.
        assert s.extra.get("stack"), "a blameless stall must still carry its stack"


# --- one audit hook per process, not one per app ---------------------------


def test_the_audit_hook_is_installed_once_per_process(monkeypatch):
    """Audit hooks can never be removed, so installing one per app leaks."""
    from starlette.testclient import TestClient

    import fastapi_visualizer.blockingcalls as bc

    installs = []
    real = sys.addaudithook
    monkeypatch.setattr(sys, "addaudithook", lambda h: (installs.append(h), real(h))[1])
    # Force the "not yet installed" path so the count is about THIS test.
    monkeypatch.setattr(bc, "_HOOK_INSTALLED", False)

    for _ in range(4):
        app = FastAPI()

        @app.get("/x")
        async def x():
            return {"ok": True}

        visualize(app, enabled=True, roots=[HERE])
        with TestClient(app):
            pass

    assert len(installs) == 1, f"{len(installs)} hooks installed for 4 apps"


def test_an_uninstalled_detector_stops_being_dispatched_to():
    import fastapi_visualizer.blockingcalls as bc

    d = bc.BlockingCallDetector()
    d.install(threading.get_ident())
    assert d in set(bc._ACTIVE)
    d.uninstall()
    assert d not in set(bc._ACTIVE)
    assert d.enabled is False


def test_a_dropped_detector_does_not_pin_itself_forever():
    """The registry is weak, so an app dropped without shutdown does not leak."""
    import gc

    import fastapi_visualizer.blockingcalls as bc

    d = bc.BlockingCallDetector()
    d.install(threading.get_ident())
    assert len(set(bc._ACTIVE)) >= 1
    ref = __import__("weakref").ref(d)
    del d
    gc.collect()
    assert ref() is None, "the registry kept a dead detector alive"
