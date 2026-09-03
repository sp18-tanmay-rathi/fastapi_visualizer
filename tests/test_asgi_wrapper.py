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
    """A Django ASGI app built here, not imported from examples/.

    Deliberately self-contained: `settings.configure()` is process-global, so
    importing the demo would couple these tests to the example's content and
    to whatever else has already configured Django in this process.
    """
    import sqlite3
    import time

    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=True,
            SECRET_KEY="test-only-not-a-real-secret",
            ALLOWED_HOSTS=["*"],
            ROOT_URLCONF=__name__,
            INSTALLED_APPS=[],
            MIDDLEWARE=[],
            DATABASES={},
        )
        django.setup()

    from django.core.asgi import get_asgi_application
    from django.http import JsonResponse
    from django.urls import path as urlpath

    async def db_fetch():
        await asyncio.sleep(0.2)
        return {"id": 1}

    async def async_view(request):
        return JsonResponse({"user": await db_fetch()})

    def query_db():
        time.sleep(0.2)
        return {"id": 1}

    def sync_view(request):
        return JsonResponse({"user": query_db()})

    async def blocking_view(request):
        time.sleep(0.35)  # no await: holds the loop
        return JsonResponse({"mode": "blocking"})

    async def fast_db_view(request):
        con = sqlite3.connect(":memory:")
        con.execute("select 1").fetchone()
        con.close()
        return JsonResponse({"mode": "fast db"})

    # ROOT_URLCONF points at this module, so the patterns live at module scope
    # — and they are all registered HERE. Django caches its URL resolver, so a
    # test that appends to `urlpatterns` after another test has already
    # resolved gets a 404.
    global urlpatterns
    urlpatterns = [
        urlpath("async", async_view),
        urlpath("sync", sync_view),
        urlpath("blocking", blocking_view),
        urlpath("fast_db", fast_db_view),
    ]

    return visualize(get_asgi_application(), enabled=True, roots=[str(HERE)])


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


async def test_bare_mount_path_redirects_to_trailing_slash():
    """`/_viz` must 307 to `/_viz/`, matching Starlette's Mount.

    index.html loads `./dashboard.js` relatively: served at `/_viz` the browser
    resolves that to `/dashboard.js` and asks the wrapped app for it (a 404
    from Django), instead of `/_viz/dashboard.js`.
    """
    app = visualize(plain_app, roots=[HERE], enabled=True)
    async with client_for_asgi(app) as client:
        r = await client.get("/_viz")  # httpx does not auto-follow
        assert r.status_code == 307
        assert r.headers["location"].endswith("/_viz/")

        r = await client.get("/debug")  # unrelated path still falls through
        assert r.status_code == 200


async def test_bare_custom_path_redirects_too():
    app = visualize(plain_app, roots=[HERE], enabled=True, path="/debug/viz")
    async with client_for_asgi(app) as client:
        r = await client.get("/debug/viz")
        assert r.status_code == 307
        assert r.headers["location"].endswith("/debug/viz/")


# --- what the newer detectors do on Django ---------------------------------
# The POC's original claim was that no instrumentation needs to change for
# another framework. Three detectors have been added since it was written, so
# that claim is worth re-checking rather than assumed.


async def test_django_blocking_view_is_detected(django_app):
    """The timer and the watchdog both work, and blame the Django view."""
    collector.clear()
    async with client_for_asgi(django_app) as client:
        assert (await client.get("/blocking")).status_code == 200
    await asyncio.sleep(0.3)  # let the watchdog's own thread report

    events = collector.snapshot()
    blocked = [e for e in events if e.kind == "loop_blocked"]
    assert blocked, "the timer missed a 350ms block in a Django view"
    # the view is defined inside the fixture, so its qualname carries that
    # scope — the same reason the FastAPI watchdog tests match on a suffix
    assert any(
        str(e.extra.get("qualname", "")).endswith("blocking_view") for e in blocked
    ), f"blamed the wrong frame: {[e.extra.get('qualname') for e in blocked]}"


async def test_django_fast_blocking_call_is_detected(django_app):
    """The audit-hook listener hooks the INTERPRETER, not the framework.

    A ~1ms database connect is invisible to any threshold, so this is the one
    detector whose framework-independence is worth proving rather than
    assuming.
    """
    collector.clear()
    async with client_for_asgi(django_app) as client:
        assert (await client.get("/fast_db")).status_code == 200

    calls = [e for e in collector.snapshot() if e.kind == "blocking_call"]
    assert calls, "the listener missed a blocking database call in Django"
    assert any(e.extra.get("category") == "database" for e in calls), (
        f"categories seen: {[e.extra.get('category') for e in calls]}"
    )


async def test_django_offloads_are_observable_even_without_pool_samples(django_app):
    """The known gap, pinned as a fact rather than left as folklore.

    Django dispatches sync views through asgiref's own executor, so AnyIO's
    capacity limiter never moves and NO pool_sample is emitted. The row still
    lands in the right zone, and the dashboard's busy count survives because
    it takes max(sampled, observed) — observed being these offload events,
    which do fire. If a future change makes the header trust the sampler
    alone, Django's worker gauge silently reads zero again.
    """
    collector.clear()
    async with client_for_asgi(django_app) as client:
        assert (await client.get("/sync")).status_code == 200

    events = collector.snapshot()
    # The poller emits one baseline sample at startup, so the gap is not
    # "no samples" but "borrowed never rises off zero".
    busy = [
        e.extra.get("borrowed", 0)
        for e in events
        if e.kind == "pool_sample"
    ]
    assert not any(b > 0 for b in busy), (
        "AnyIO's limiter moved on Django — if asgiref now routes through it, "
        f"the documented gap is closed and the docs should say so: {busy}"
    )
    assert [e for e in events if e.kind == "offload_start"], (
        "no offload events, so the busy count has nothing to fall back on"
    )
