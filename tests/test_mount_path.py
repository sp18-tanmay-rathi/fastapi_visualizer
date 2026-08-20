"""The dashboard mount path is configurable via visualize(app, path=...)."""

import os

import pytest
from fastapi import FastAPI

from fastapi_visualizer import visualize
from fastapi_visualizer.app import _normalize_mount_path

HERE = os.path.dirname(os.path.abspath(__file__))


def _app():
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    return app


def _mount_paths(app):
    return [getattr(r, "path", None) for r in app.routes]


# --- normalization --------------------------------------------------------


@pytest.mark.parametrize(
    "given,expected",
    [
        ("/_viz", "/_viz"),
        ("_viz", "/_viz"),
        ("/_viz/", "/_viz"),
        ("/debug/viz/", "/debug/viz"),
        ("  /debug/viz  ", "/debug/viz"),
    ],
)
def test_path_normalization(given, expected):
    assert _normalize_mount_path(given) == expected


@pytest.mark.parametrize("bad", ["/", "", "   ", "///"])
def test_root_mount_is_rejected(bad):
    # Mounting at the root would shadow the app's own routes — a config mistake
    # worth failing loudly on.
    with pytest.raises(ValueError):
        _normalize_mount_path(bad)


# --- end-to-end serving ---------------------------------------------------


async def test_default_path_is_viz(client_for):
    app = _app()
    visualize(app, roots=[HERE])
    async with client_for(app) as client:
        assert (await client.get("/_viz/")).status_code == 200
        assert (await client.get("/_viz/dashboard.js")).status_code == 200


async def test_custom_path_is_served_and_default_is_not(client_for):
    app = _app()
    visualize(app, roots=[HERE], path="/debug/viz")

    async with client_for(app) as client:
        assert (await client.get("/debug/viz/")).status_code == 200
        assert (await client.get("/debug/viz/dashboard.js")).status_code == 200
        # Nothing left behind at the old location.
        assert (await client.get("/_viz/")).status_code == 404
        # The app's own routes still work.
        assert (await client.get("/w")).status_code == 200


async def test_custom_path_is_normalized_when_mounted(client_for):
    app = _app()
    visualize(app, roots=[HERE], path="debug/viz/")  # no leading, has trailing
    assert "/debug/viz" in _mount_paths(app)
    async with client_for(app) as client:
        assert (await client.get("/debug/viz/")).status_code == 200


async def test_websocket_route_lives_under_the_mount(client_for):
    """dashboard.js derives the socket URL from location.pathname, so the ws
    route must be the mount's own "/ws" child rather than an absolute path."""
    app = _app()
    visualize(app, roots=[HERE], path="/debug/viz")

    mount = next(r for r in app.routes if getattr(r, "path", None) == "/debug/viz")
    assert "/ws" in [getattr(r, "path", None) for r in mount.app.routes]


async def test_bad_path_does_not_raise_when_disabled(monkeypatch):
    """A disabled visualizer touches nothing, so it must not raise on config
    it never uses — the error surfaces the moment you enable it."""
    monkeypatch.delenv("FASTAPI_VIZ", raising=False)
    app = _app()
    visualize(app, roots=[HERE], path="/")  # would raise if enabled
    assert app.state._viz == {"enabled": False}


async def test_bad_path_raises_when_enabled():
    app = _app()
    with pytest.raises(ValueError):
        visualize(app, roots=[HERE], path="/", enabled=True)
