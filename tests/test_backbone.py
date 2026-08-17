"""Backbone tests: call-tree tracing produces a nested tree with suspend/resume."""

import asyncio

import httpx
import pytest
from fastapi import FastAPI

from fastapi_visualizer import collector, visualize


@pytest.fixture
def app():
    app = FastAPI()

    async def nested():
        await asyncio.sleep(0.05)

    @app.get("/work")
    async def work():
        await nested()
        await asyncio.sleep(0.05)
        return {"ok": True}

    visualize(app)
    return app


async def test_call_tree_and_suspend_resume(app):
    collector.clear()
    # Drive the app's lifespan (visualize() installs the monitor by wrapping
    # lifespan_context, which httpx.ASGITransport does not run on its own).
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            responses = await asyncio.gather(*[client.get("/work") for _ in range(5)])
        assert all(r.status_code == 200 for r in responses)

    events = collector.snapshot()
    kinds = [e.kind for e in events]

    assert kinds.count("request_start") >= 1
    assert kinds.count("suspend") >= 1
    assert kinds.count("resume") >= 1

    enters = [e for e in events if e.kind == "call_enter"]
    exits = [e for e in events if e.kind == "call_exit"]
    assert enters, "expected at least one call_enter"

    enter_ids = {e.extra["node_id"] for e in enters}
    exit_ids = {e.extra["node_id"] for e in exits}
    assert enter_ids == exit_ids  # every entered frame eventually exits

    # nested tree: some node's parent_id refers to a node we saw call_enter for
    assert any(
        e.extra.get("parent_id") is not None and e.extra["parent_id"] in enter_ids
        for e in enters
    )

    trace_ids = {e.trace_id for e in events if e.trace_id and e.kind == "request_start"}
    assert len(trace_ids) >= 2  # multiple concurrent requests were traced separately
