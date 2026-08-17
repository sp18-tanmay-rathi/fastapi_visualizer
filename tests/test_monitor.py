"""Event-model invariants: classification, scoping, fail-soft, child tasks, seq.

These guard the correctness fixes in Phase 1 — breaking any of them should fail
a test immediately (that's the point of the safety net).
"""

import asyncio
import os

import pytest
from fastapi import Depends, FastAPI

from fastapi_visualizer import collector, visualize
from fastapi_visualizer import monitor as monitor_mod

HERE = os.path.dirname(os.path.abspath(__file__))


def _enters(events):
    return [e for e in events if e.kind == "call_enter"]


def _node_of(events, needle):
    """First call_enter whose qualname contains `needle`."""
    for e in _enters(events):
        if needle in e.extra.get("qualname", ""):
            return e
    return None


# --- classification: async generator vs sync def (task 6) -----------------


async def test_async_generator_dependency_not_offloaded(client_for):
    app = FastAPI()

    async def get_thing():
        # async def ... yield  -> an async GENERATOR; runs on the loop.
        yield "value"

    @app.get("/dep")
    async def ep(x: str = Depends(get_thing)):
        return {"x": x}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        r = await client.get("/dep")
    assert r.status_code == 200

    events = collector.snapshot()
    dep = _node_of(events, "get_thing")
    assert dep is not None, "expected the async-generator dependency to be traced"
    assert dep.extra.get("is_async") is True
    assert dep.extra.get("execution") == "event_loop"

    # It must NOT be offloaded: no offload_start references its node.
    offload_nodes = {
        e.extra.get("node_id") for e in events if e.kind == "offload_start"
    }
    assert dep.extra["node_id"] not in offload_nodes


async def test_sync_endpoint_is_offloaded(client_for):
    app = FastAPI()

    @app.get("/sync")
    def sync_ep():
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        r = await client.get("/sync")
    assert r.status_code == 200

    events = collector.snapshot()
    node = _node_of(events, "sync_ep")
    assert node is not None
    assert node.extra.get("is_async") is False
    assert node.extra.get("execution") == "threadpool"

    offload_nodes = {
        e.extra.get("node_id") for e in events if e.kind == "offload_start"
    }
    assert node.extra["node_id"] in offload_nodes
    assert any(e.kind == "offload_end" for e in events)


# --- custom lifespan still installs (regression) --------------------------


async def test_custom_lifespan_still_traces(client_for):
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(app_):
        yield

    app = FastAPI(lifespan=lifespan)

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.01)
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        r = await client.get("/w")
    assert r.status_code == 200
    assert _enters(collector.snapshot()), "custom-lifespan app should still trace"


# --- fail-soft: monitoring unavailable ------------------------------------


async def test_monitoring_conflict_degrades_gracefully(client_for, monkeypatch):
    def boom(*a, **k):
        raise ValueError("no free tool id")

    # Simulate sys.monitoring tool-id exhaustion; install() must not crash the
    # app, and request-level tracing (middleware, not monitor-scoped) survives.
    monkeypatch.setattr(monitor_mod.m, "use_tool_id", boom)

    app = FastAPI()

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.01)
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        r = await client.get("/w")
    assert r.status_code == 200

    events = collector.snapshot()
    assert any(e.kind == "request_start" for e in events)
    assert any(e.kind == "request_end" for e in events)
    assert not _enters(events)  # monitor never installed -> no call tree


# --- roots scoping --------------------------------------------------------


async def test_roots_scoping_excludes_out_of_root(client_for, tmp_path):
    app = FastAPI()

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.01)
        return {"ok": True}

    # Endpoint lives in THIS file, which is not under tmp_path -> out of root.
    visualize(app, roots=[str(tmp_path)])
    collector.clear()
    async with client_for(app) as client:
        r = await client.get("/w")
    assert r.status_code == 200

    events = collector.snapshot()
    assert not _enters(events)
    assert any(e.kind == "request_start" for e in events)  # request tracing still on


async def test_roots_scoping_includes_in_root(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.01)
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        r = await client.get("/w")
    assert r.status_code == 200
    assert _enters(collector.snapshot())


# --- suspend/resume pairing ------------------------------------------------


async def test_suspend_is_followed_by_resume_or_exit(client_for):
    app = FastAPI()

    async def inner():
        await asyncio.sleep(0.02)

    @app.get("/w")
    async def w():
        await inner()
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    events = collector.snapshot()
    # Per (trace, node), every suspend must be answered by a later resume or
    # call_exit for the same node.
    for i, e in enumerate(events):
        if e.kind != "suspend":
            continue
        node = e.extra.get("node_id")
        answered = any(
            later.trace_id == e.trace_id
            and later.extra.get("node_id") == node
            and later.kind in ("resume", "call_exit")
            for later in events[i + 1 :]
        )
        assert answered, f"suspend of node {node} never resumed/exited"


# --- child-task trace propagation (task 17 relies on this) -----------------


async def test_child_task_inherits_trace_keeps_own_task_id(client_for):
    app = FastAPI()

    async def child_work():
        await asyncio.sleep(0.01)

    @app.get("/spawn")
    async def spawn():
        t = asyncio.create_task(child_work())
        await t
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        r = await client.get("/spawn")
    assert r.status_code == 200

    events = collector.snapshot()
    child = _node_of(events, "child_work")
    assert child is not None, "child task's frame should be traced"

    trace = child.trace_id
    enters_for_trace = [e for e in _enters(events) if e.trace_id == trace]
    task_ids = {e.task_id for e in enters_for_trace}
    # Same request/trace, but the parent handler and the child task run in
    # distinct asyncio tasks -> distinct task_ids under one trace_id.
    assert len(task_ids) >= 2


# --- event sequence numbers (task 15) --------------------------------------


async def test_events_have_monotonic_contiguous_seq(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.01)
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    events = collector.snapshot()
    seqs = [e.seq for e in events]
    # clear() resets the counter; in-process nothing is dropped, so seq is a
    # contiguous 1..N run assigned in push order.
    assert seqs == list(range(1, len(events) + 1))
