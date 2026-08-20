"""Task 14: request outcome (status / duration / error) and request-id handling."""

import asyncio
import os

import pytest
from fastapi import FastAPI

from fastapi_visualizer import collector, visualize

HERE = os.path.dirname(os.path.abspath(__file__))


def _kind(events, kind):
    return [e for e in events if e.kind == kind]


def _one_end(events):
    ends = _kind(events, "request_end")
    assert ends, "expected a request_end event"
    return ends[-1]


# --- status + duration ----------------------------------------------------


async def test_request_end_carries_status_and_duration(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        await asyncio.sleep(0.02)
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/w")).status_code == 200

    end = _one_end(collector.snapshot())
    assert end.extra.get("status") == 200
    # >= the awaited sleep, and a sane upper bound (timing-robust).
    assert 20 <= end.extra.get("duration_ms") < 10_000
    assert "error" not in end.extra


async def test_status_reflects_non_200(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        assert (await client.get("/nope")).status_code == 404

    assert _one_end(collector.snapshot()).extra.get("status") == 404


async def test_raising_endpoint_records_error_and_reraises(client_for):
    app = FastAPI()

    @app.get("/boom")
    async def boom():
        raise RuntimeError("kaboom")

    visualize(app, roots=[HERE])
    collector.clear()
    # The visualizer must not swallow the application's exception: it propagates
    # out to Starlette's ServerErrorMiddleware (which sits OUTSIDE our
    # middleware, so no response has started by the time we record).
    with pytest.raises(RuntimeError):
        async with client_for(app) as client:
            await client.get("/boom")

    end = _one_end(collector.snapshot())
    assert end.extra.get("error") == "RuntimeError"


# --- trace id width ------------------------------------------------------


async def test_trace_id_is_16_hex_chars(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    visualize(app, roots=[HERE])
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w")

    tid = _kind(collector.snapshot(), "request_start")[0].trace_id
    assert len(tid) == 16
    int(tid, 16)  # hex


# --- inbound X-Request-ID correlation ------------------------------------


async def test_inbound_request_id_recorded_but_not_used_by_default(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    visualize(app, roots=[HERE])  # correlate_request_id defaults to False
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w", headers={"X-Request-ID": "abc-123"})

    start = _kind(collector.snapshot(), "request_start")[0]
    assert start.extra.get("request_id") == "abc-123"
    # Recorded for correlation, but a client must not be able to choose the
    # trace id unless the app opted in.
    assert start.trace_id != "abc-123"
    assert len(start.trace_id) == 16


async def test_correlated_request_id_becomes_trace_id(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    visualize(app, roots=[HERE], correlate_request_id=True)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w", headers={"X-Request-ID": "abc-123"})

    assert _kind(collector.snapshot(), "request_start")[0].trace_id == "abc-123"


async def test_correlated_request_id_is_sanitized(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    visualize(app, roots=[HERE], correlate_request_id=True)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w", headers={"X-Request-ID": "bad id/../x"})

    # Spaces and slashes are dropped; the id is rendered in the dashboard and
    # used as a map key, so it is filtered rather than trusted verbatim.
    assert _kind(collector.snapshot(), "request_start")[0].trace_id == "badid..x"


async def test_unusable_inbound_id_falls_back_to_generated(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    visualize(app, roots=[HERE], correlate_request_id=True)
    collector.clear()
    async with client_for(app) as client:
        await client.get("/w", headers={"X-Request-ID": "///"})

    assert len(_kind(collector.snapshot(), "request_start")[0].trace_id) == 16


# --- outbound response header --------------------------------------------


async def test_response_header_absent_by_default(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    visualize(app, roots=[HERE])
    async with client_for(app) as client:
        r = await client.get("/w")
    assert "x-request-id" not in r.headers


async def test_expose_request_id_sends_header(client_for):
    app = FastAPI()

    @app.get("/w")
    async def w():
        return {"ok": True}

    visualize(app, roots=[HERE], expose_request_id=True)
    collector.clear()
    async with client_for(app) as client:
        r = await client.get("/w")

    tid = _kind(collector.snapshot(), "request_start")[0].trace_id
    assert r.headers.get("x-request-id") == tid
