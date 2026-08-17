"""Threadpool tests: sync endpoints show up as pool_sample saturation."""

import asyncio
import time

import httpx
import pytest
from fastapi import FastAPI

from fastapi_visualizer import collector, visualize


@pytest.fixture
def app():
    app = FastAPI()

    @app.get("/work")
    def work():
        time.sleep(0.1)
        return {"ok": True}

    visualize(app)
    return app


async def test_threadpool_saturation_is_sampled(app):
    collector.clear()
    # Drive the app's lifespan so visualize()'s startup (pool poller install)
    # runs — httpx.ASGITransport does not run lifespan on its own.
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            requests = [client.get("/work") for _ in range(10)]
            # Give the pool poller a couple of ticks while requests are in flight.
            gather_task = asyncio.gather(*requests)
            await asyncio.sleep(0.15)
            responses = await gather_task
        assert all(r.status_code == 200 for r in responses)

    events = collector.snapshot()
    pool_samples = [e for e in events if e.kind == "pool_sample"]

    assert len(pool_samples) >= 1
    max_borrowed = max(e.extra.get("borrowed", 0) for e in pool_samples)
    assert max_borrowed > 0

    # best-effort offload attribution for the sync `def` endpoint
    assert any(e.kind == "offload_start" for e in events)
    assert any(e.kind == "offload_end" for e in events)
