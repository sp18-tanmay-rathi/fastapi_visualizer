"""Shared test helpers.

`client_for` drives an app through its real lifespan (visualize() installs the
monitor by wrapping lifespan_context, which httpx.ASGITransport does not run on
its own) and hands back an httpx client bound to it.
"""

from contextlib import asynccontextmanager

import httpx
import pytest


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
