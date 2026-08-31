"""visualize() against a non-Starlette ASGI app (the wrap strategy).

One entry point serves both: visualize() mutates a Starlette app in place and
wraps anything else. These cover the wrap half — a hand-written ASGI app and a
real Django ASGIHandler.
"""

import asyncio
import os
from contextlib import asynccontextmanager

import httpx
import pytest

from fastapi_visualizer import collector, visualize
from fastapi_visualizer.asgi import VisualizedASGIApp

HERE = os.path.dirname(os.path.abspath(__file__))


def _enters(events):
    return [e for e in events if e.kind == "call_enter"]


def _node_of(events, needle):
    for e in _enters(events):
        if needle in e.extra.get("qualname", ""):
            return e
    return None


@asynccontextmanager
async def lifespan(app):
    """Drive the ASGI lifespan protocol by hand.

    httpx.ASGITransport does not run lifespan, and the wrapper installs the
    monitor there — so without this the tests would trace nothing.
    """
    receive_q: asyncio.Queue = asyncio.Queue()
    send_q: asyncio.Queue = asyncio.Queue()

    task = asyncio.create_task(
        app({"type": "lifespan"}, receive_q.get, send_q.put)
    )
    await receive_q.put({"type": "lifespan.startup"})
    started = await send_q.get()
    assert started["type"] == "lifespan.startup.complete", started
    try:
        yield
    finally:
        await receive_q.put({"type": "lifespan.shutdown"})
        try:
            await asyncio.wait_for(send_q.get(), timeout=2)
            await asyncio.wait_for(task, timeout=2)
        except Exception:
            task.cancel()


@asynccontextmanager
async def client_for_asgi(app):
    async with lifespan(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            yield client


# --- plain ASGI app (no framework at all) ---------------------------------


async def _plain_helper():
    await asyncio.sleep(0.01)
    return b"ok"


async def plain_app(scope, receive, send):
    body = await _plain_helper()
    await send(
        {"type": "http.response.start", "status": 200, "headers": [(b"x", b"1")]}
    )
    await send({"type": "http.response.body", "body": body})


async def test_disabled_returns_the_original_app(monkeypatch):
    monkeypatch.delenv("FASTAPI_VIZ", raising=False)
    # A bare ASGI callable has no .debug, so auto-detect resolves to off.
    wrapped = visualize(plain_app, roots=[HERE])
    assert wrapped is plain_app


async def test_wraps_a_plain_asgi_app_and_traces_it():
    app = visualize(plain_app, roots=[HERE], enabled=True)
    assert isinstance(app, VisualizedASGIApp)
    assert app.state["enabled"] is True

    collector.clear()
    async with client_for_asgi(app) as client:
        r = await client.get("/hello")
    assert r.status_code == 200

    events = collector.snapshot()
    assert any(e.kind == "request_start" for e in events)
    assert _node_of(events, "_plain_helper") is not None


async def test_serves_the_dashboard_under_the_mount_path():
    app = visualize(plain_app, roots=[HERE], enabled=True)
    async with client_for_asgi(app) as client:
        assert (await client.get("/_viz/")).status_code == 200
        assert (await client.get("/_viz/dashboard.js")).status_code == 200
        # ...and the wrapped app still owns everything else.
        assert (await client.get("/anything-else")).status_code == 200


async def test_custom_path_moves_the_dashboard():
    app = visualize(plain_app, roots=[HERE], enabled=True, path="/debug/viz")
    async with client_for_asgi(app) as client:
        assert (await client.get("/debug/viz/")).status_code == 200
        # /_viz is no longer the dashboard, so it falls through to the app.
        assert (await client.get("/_viz/")).status_code == 200


# --- Django ---------------------------------------------------------------

django = pytest.importorskip("django", reason="django is an optional dev dep")


@pytest.fixture(scope="module")
def django_app():
    from examples.django_demo import application

    return application


async def test_django_async_view_traced_on_the_loop(django_app):
    collector.clear()
    async with client_for_asgi(django_app) as client:
        r = await client.get("/async")
    assert r.status_code == 200

    events = collector.snapshot()
    view = _node_of(events, "async_view")
    assert view is not None, "Django async view should be traced"
    assert view.extra["execution"] == "event_loop"
    # the nested chain is reconstructed, not just the entry point
    assert _node_of(events, "db_fetch") is not None
    assert any(e.kind == "suspend" for e in events)


async def test_django_sync_view_is_offloaded(django_app):
    collector.clear()
    async with client_for_asgi(django_app) as client:
        r = await client.get("/sync")
    assert r.status_code == 200

    events = collector.snapshot()
    view = _node_of(events, "sync_view")
    assert view is not None
    # Django runs sync views on a worker thread via asgiref, where there is no
    # current asyncio task — the same signal the FastAPI path keys off.
    assert view.extra["execution"] == "threadpool"
    offloaded = {e.extra.get("node_id") for e in events if e.kind == "offload_start"}
    assert view.extra["node_id"] in offloaded


async def test_django_request_outcome_recorded(django_app):
    collector.clear()
    async with client_for_asgi(django_app) as client:
        await client.get("/async")

    ends = [e for e in collector.snapshot() if e.kind == "request_end"]
    assert ends
    assert ends[-1].extra.get("status") == 200
    assert ends[-1].extra.get("duration_ms") >= 200


# --- strategy selection ----------------------------------------------------
# One entry point, two attach strategies. These pin which one is chosen, since
# the difference is observable: mutate returns the SAME object, wrap returns a
# new one that the caller must bind.


async def test_starlette_app_is_mutated_in_place_and_returned():
    from fastapi import FastAPI

    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    returned = visualize(app, roots=[HERE], enabled=True)

    # Same object: existing callers that ignore the return value still work.
    assert returned is app
    assert not isinstance(returned, VisualizedASGIApp)
    assert app.state._viz["enabled"] is True


async def test_non_starlette_app_is_wrapped_not_mutated():
    returned = visualize(plain_app, roots=[HERE], enabled=True)

    assert returned is not plain_app
    assert isinstance(returned, VisualizedASGIApp)
    # The original is untouched — nothing was bolted onto it.
    assert not hasattr(plain_app, "state")


async def test_both_strategies_reach_the_same_dashboard():
    from fastapi import FastAPI

    fast = visualize(FastAPI(), roots=[HERE], enabled=True)
    plain = visualize(plain_app, roots=[HERE], enabled=True)

    async with fast.router.lifespan_context(fast):
        transport = httpx.ASGITransport(app=fast)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            assert (await c.get("/_viz/")).status_code == 200

    async with client_for_asgi(plain) as c:
        assert (await c.get("/_viz/")).status_code == 200
