"""Task 7: the visualizer must be opt-in and must not alter the host app.

The autouse `viz_enabled` fixture in conftest.py exports FASTAPI_VIZ=1 for the
suite, so the tests here that exercise the OFF path delete it explicitly.
"""

import asyncio
import os

import pytest
from fastapi import FastAPI

from fastapi_visualizer import collector, visualize

HERE = os.path.dirname(os.path.abspath(__file__))


def _app():
    app = FastAPI()

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.01)
        return {"ok": True}

    return app


def _enters(events):
    return [e for e in events if e.kind == "call_enter"]


async def test_disabled_by_default_installs_nothing(client_for, monkeypatch):
    monkeypatch.delenv("FASTAPI_VIZ", raising=False)
    app = _app()  # FastAPI() -> debug is False
    visualize(app, roots=[HERE])

    assert app.state._viz == {"enabled": False}

    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/w")).status_code == 200
        # Nothing mounted: the dashboard route does not exist.
        assert (await client.get("/_viz/")).status_code == 404

    events = collector.snapshot()
    # No middleware either, so not even request-level events are emitted. This
    # is stronger than the monitoring-conflict case in test_monitor.py, where
    # the middleware is installed and request_start/end still flow.
    assert not events


async def test_explicit_enabled_true_overrides_env(client_for, monkeypatch):
    monkeypatch.delenv("FASTAPI_VIZ", raising=False)
    app = _app()
    visualize(app, roots=[HERE], enabled=True)

    assert app.state._viz["enabled"] is True

    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/w")).status_code == 200
    assert _enters(collector.snapshot())


async def test_env_flag_enables(client_for, monkeypatch):
    monkeypatch.setenv("FASTAPI_VIZ", "1")
    app = _app()
    visualize(app, roots=[HERE])  # enabled=None -> auto

    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/w")).status_code == 200
    assert _enters(collector.snapshot())


async def test_app_debug_enables(client_for, monkeypatch):
    monkeypatch.delenv("FASTAPI_VIZ", raising=False)
    app = FastAPI(debug=True)

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.01)
        return {"ok": True}

    visualize(app, roots=[HERE])

    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/w")).status_code == 200
    assert _enters(collector.snapshot())


async def test_explicit_enabled_false_wins_over_env(client_for, monkeypatch):
    monkeypatch.setenv("FASTAPI_VIZ", "1")
    app = _app()
    visualize(app, roots=[HERE], enabled=False)
    assert app.state._viz == {"enabled": False}


async def test_does_not_enable_asyncio_debug_mode(client_for):
    """visualize() used to call loop.set_debug(True) unconditionally.

    That changes the host app's behavior (slow-callback logging, coroutine
    origin tracking) and costs overhead. Blocking detection does not need it —
    monitor.py times sys.monitoring boundaries itself.
    """
    loop = asyncio.get_running_loop()
    loop.set_debug(False)

    app = _app()
    visualize(app, roots=[HERE])
    async with client_for(app) as client:
        assert (await client.get("/w")).status_code == 200

    assert loop.get_debug() is False, "visualize() must not enable asyncio debug mode"
