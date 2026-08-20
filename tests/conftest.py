"""Shared test helpers.

`client_for` drives an app through its real lifespan (visualize() installs the
monitor by wrapping lifespan_context, which httpx.ASGITransport does not run on
its own) and hands back an httpx client bound to it.
"""

from contextlib import asynccontextmanager

import httpx
import pytest


@pytest.fixture(autouse=True)
def viz_enabled(monkeypatch):
    """Turn the visualizer on for the whole suite.

    Since task 7 `visualize()` installs nothing unless FASTAPI_VIZ is set or
    app.debug is true, so without this every test would silently trace nothing.
    Setting it here (rather than passing enabled=True at 13 call sites) keeps
    test bodies about the behavior they assert. Tests that need the gate OFF
    delete the var themselves — see tests/test_enable.py.
    """
    monkeypatch.setenv("FASTAPI_VIZ", "1")


@pytest.fixture
def client_for():
    @asynccontextmanager
    async def _cm(app):
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                yield client

    return _cm
