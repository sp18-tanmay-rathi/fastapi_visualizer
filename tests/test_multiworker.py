"""Tests for multi-worker detection and dashboard meta frame."""

import json
import os
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from fastapi_visualizer import visualize


# --- _is_multi_worker() unit tests -------------------------------------------


def test_single_worker_by_default():
    from fastapi_visualizer.app import _is_multi_worker
    env = {k: v for k, v in os.environ.items() if k not in ("WEB_CONCURRENCY", "UVICORN_WORKERS")}
    with patch.dict(os.environ, env, clear=True):
        assert _is_multi_worker() is False


def test_web_concurrency_one_is_single():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"WEB_CONCURRENCY": "1"}, clear=False):
        assert _is_multi_worker() is False


def test_web_concurrency_multi():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"WEB_CONCURRENCY": "4"}, clear=False):
        assert _is_multi_worker() is True


def test_uvicorn_workers_multi():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"UVICORN_WORKERS": "2"}, clear=False):
        assert _is_multi_worker() is True


def test_uvicorn_workers_one_is_single():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"UVICORN_WORKERS": "1"}, clear=False):
        assert _is_multi_worker() is False


def test_bad_env_value_treated_as_single():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"WEB_CONCURRENCY": "not-a-number"}, clear=False):
        assert _is_multi_worker() is False


# --- WS meta frame tests ------------------------------------------------------
# Use TestClient only (no manual lifespan context) — TestClient manages the
# app lifespan itself; nesting a manual lifespan_context inside TestClient
# installs two overlapping sys.monitoring registrations which corrupts state
# and causes unrelated test failures.


def test_ws_first_frame_has_meta_single_worker():
    """Single-worker: first WS frame has meta with multi_worker=False."""
    app = FastAPI()

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    env = {k: v for k, v in os.environ.items() if k not in ("WEB_CONCURRENCY", "UVICORN_WORKERS")}
    with patch.dict(os.environ, env, clear=True):
        visualize(app)
        with TestClient(app) as client:
            with client.websocket_connect("/_viz/ws") as ws:
                frame = json.loads(ws.receive_text())

    assert "meta" in frame, f"meta missing: {list(frame.keys())}"
    assert isinstance(frame["meta"]["worker_pid"], int)
    assert frame["meta"]["multi_worker"] is False


def test_ws_first_frame_meta_multi_worker():
    """Multi-worker: first WS frame has meta with multi_worker=True."""
    app = FastAPI()

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    with patch.dict(os.environ, {"WEB_CONCURRENCY": "3"}, clear=False):
        visualize(app)
        with TestClient(app) as client:
            with client.websocket_connect("/_viz/ws") as ws:
                frame = json.loads(ws.receive_text())

    assert "meta" in frame
    assert frame["meta"]["multi_worker"] is True
    assert frame["meta"]["worker_pid"] == os.getpid()
