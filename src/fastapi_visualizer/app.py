"""visualize(app): attaches instrumentation and mounts the /_viz dashboard."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from starlette.applications import Starlette
from starlette.responses import FileResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocketDisconnect

from . import identity, threadpool
from .collector import collector
from .identity import TraceMiddleware
from .monitor import Monitor

STATIC_DIR = Path(__file__).parent / "static"

ENV_FLAG = "FASTAPI_VIZ"
_ENV_TRUTHY = ("1", "true", "yes", "on")


def _resolve_enabled(app, enabled: bool | None) -> bool:
    """Decide whether to install anything at all.

    An explicit `enabled=` always wins. Otherwise this is a DEV tool, so it
    turns itself on only where a dev-environment signal exists: the FASTAPI_VIZ env flag
    or the app's own debug mode. Default-off matters because installing means
    global sys.monitoring callbacks, a wrapped task factory, a polling task and
    an unauthenticated /_viz mount — none of which should appear in production
    just because the import is still there.
    """
    if enabled is not None:
        return bool(enabled)
    try:
        env = os.environ.get(ENV_FLAG, "").strip().lower()
    except Exception:
        env = ""
    if env in _ENV_TRUTHY:
        return True
    try:
        return bool(getattr(app, "debug", False))
    except Exception:
        return False


def _normalize_mount_path(path: str) -> str:
    """Normalize the dashboard mount path to a leading slash, no trailing one.

    Accepts "/_viz", "_viz", "/debug/viz/" alike. Raises on a root mount: that
    would shadow the application's own routes, which is a config mistake worth
    failing loudly on rather than silently breaking the app the tool is
    supposed to be observing.
    """
    normalized = "/" + str(path).strip().strip("/")
    if normalized == "/":
        raise ValueError(
            "fastapi_visualizer: path must not be '/' or empty — mounting the "
            "dashboard at the root would shadow the application's own routes"
        )
    return normalized


_log = logging.getLogger(__name__)


def _default_roots() -> list[str]:
    """Directory of the module that called visualize(), as a trace root."""
    try:
        caller_file = sys._getframe(2).f_globals.get("__file__")
        if caller_file:
            return [str(Path(caller_file).resolve().parent)]
    except Exception:
        pass
    return []


def _is_multi_worker() -> bool:
    """True when env signals multiple worker processes.

    Checks WEB_CONCURRENCY (set by gunicorn, Heroku, Railway) and
    UVICORN_WORKERS. Fail-soft: bad/missing values → False.
    """
    for key in ("WEB_CONCURRENCY", "UVICORN_WORKERS"):
        try:
            if int(os.environ.get(key, "1")) > 1:
                return True
        except (ValueError, TypeError):
            pass
    return False


def build_viz_app():
    """The dashboard sub-app: page, script, WebSocket.

    Split out from _mount_dashboard so the framework-agnostic ASGI
    wrapper (asgi.py) can serve the same routes without a Starlette
    host app to .mount() onto.
    """
    async def index(request):
        return FileResponse(STATIC_DIR / "index.html")

    async def dashboard_js(request):
        return FileResponse(STATIC_DIR / "dashboard.js")

    async def ws_endpoint(websocket):
        # The stream is push-only, but we MUST still read from the socket:
        # uvicorn's graceful shutdown closes each live connection (close 1012)
        # and then waits for that connection's ASGI task to finish BEFORE it
        # sends the lifespan shutdown event. A handler parked on `queue.get()`
        # never observes the queued `websocket.disconnect`, so on an idle app
        # it blocks forever and Ctrl+C appears to need a second press
        # ("Waiting for background tasks to complete"). Racing a reader task
        # against the event queue is how we see uvicorn's close.
        await websocket.accept()
        queue = collector.subscribe()

        async def wait_disconnect():
            # Return on the disconnect message OR on any receive error
            # (Starlette raises WebSocketDisconnect on some paths). Handle it
            # explicitly rather than relying on the task dying to end the outer
            # loop.
            try:
                while True:
                    msg = await websocket.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
            except Exception:
                return

        reader = asyncio.create_task(wait_disconnect())
        try:
            backlog = [e.to_dict() for e in collector.snapshot()]
            await websocket.send_json({
                "events": backlog,
                "meta": {
                    "worker_pid": os.getpid(),
                    "multi_worker": _is_multi_worker(),
                },
            })
            while not reader.done():
                getter = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {getter, reader}, return_when=asyncio.FIRST_COMPLETED
                )
                if getter not in done:
                    getter.cancel()
                    break
                batch = [getter.result()]
                while not queue.empty():
                    try:
                        batch.append(queue.get_nowait())
                    except Exception:
                        break
                await websocket.send_json({"events": [e.to_dict() for e in batch]})
                await asyncio.sleep(0.033)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            reader.cancel()
            collector.unsubscribe(queue)

    return Starlette(
        routes=[
            Route("/", index),
            Route("/dashboard.js", dashboard_js),
            WebSocketRoute("/ws", ws_endpoint),
        ]
    )


def _mount_dashboard(app, path: str) -> None:
    # The dashboard page and its WebSocket are siblings under this mount, and
    # dashboard.js derives the socket URL from its own location.pathname — so
    # nothing downstream needs to know the path we picked here.
    app.mount(path, build_viz_app())


async def install_runtime(monitor, state: dict) -> None:
    """Start tracing on the running loop. Shared by both attach strategies.

    NOTE: deliberately NO loop.set_debug(True). It changes the host app's
    behavior (slow-callback logging, coroutine origin tracking) and costs
    overhead, and blocking detection does not need it — monitor.py times wall
    clock between sys.monitoring boundaries instead of reading asyncio's
    slow-callback machinery.
    """
    try:
        loop = asyncio.get_running_loop()
    except Exception:
        return
    try:
        identity.install_task_factory(loop)
    except Exception:
        pass
    try:
        monitor.install()
    except Exception:
        pass
    try:
        task, stop_event = threadpool.start(loop)
        state["poll_task"] = task
        state["stop_event"] = stop_event
    except Exception:
        pass
    try:
        if _is_multi_worker():
            _log.warning(
                "fastapi-visualizer: running under multiple workers "
                "(PID %d) — dashboard shows only THIS worker's traffic. "
                "Run a single worker to see all requests.",
                os.getpid(),
            )
    except Exception:
        pass


async def uninstall_runtime(monitor, state: dict) -> None:
    """Stop tracing and free the sys.monitoring tool id."""
    stop_event = state.get("stop_event")
    poll_task = state.get("poll_task")
    if stop_event is not None:
        try:
            stop_event.set()
        except Exception:
            pass
    if poll_task is not None:
        try:
            await asyncio.wait_for(poll_task, timeout=1)
        except Exception:
            poll_task.cancel()
    try:
        monitor.uninstall()
    except Exception:
        pass
    try:
        identity.uninstall_task_factory(asyncio.get_running_loop())
    except Exception:
        pass


def visualize(
    app,
    roots: list[str] | None = None,
    slow_ms: int = 100,
    enabled: bool | None = None,
    path: str = "/_viz",
    correlate_request_id: bool = False,
    expose_request_id: bool = False,
) -> None:
    """Attach the visualizer to `app` and mount the dashboard at /_viz.

    enabled:
        None (default) = auto: on when FASTAPI_VIZ=1 or app.debug is true, off
        otherwise. When off, NOTHING is installed and nothing is mounted, so
        leaving the call in place is safe in production.
    slow_ms:
        blocking-detection threshold — an in-root loop frame running longer
        than this without yielding is reported as a blocking span.
    path:
        where to mount the dashboard (default "/_viz"). Useful to avoid a
        collision with an existing route, or to hide it behind a less
        guessable prefix. Must not be "/".
    correlate_request_id:
        use an inbound X-Request-ID header as the trace id when present.
    expose_request_id:
        send the trace id back as an x-request-id response header.
    """
    # Resolve the gate FIRST: when off we must not touch the app at all.
    if not _resolve_enabled(app, enabled):
        try:
            app.state._viz = {"enabled": False}
        except Exception:
            pass  # not a Starlette app — nothing to stash the flag on
        print(
            f"[fastapi_visualizer] disabled — set {ENV_FLAG}=1 or "
            "visualize(app, enabled=True) to enable"
        )
        return app

    # Validate the mount path AFTER the enable gate: a disabled visualizer
    # touches nothing, so a bad path surfaces the moment you turn it on rather
    # than raising in a production process that isn't even using it.
    path = _normalize_mount_path(path)

    if roots is None:
        roots = _default_roots()
    try:
        roots = [str(Path(r).resolve()) for r in roots]
    except Exception:
        roots = []

    monitor = Monitor(roots, slow_ms=slow_ms)
    state = {
        "enabled": True,
        "monitor": monitor,
        "poll_task": None,
        "stop_event": None,
    }

    # Two attach strategies, chosen by what the app can actually do.
    #
    # A Starlette/FastAPI app is MUTATED in place: we register middleware,
    # mount the dashboard on its router, and wrap its lifespan_context — which
    # matters because that wrap still runs the app's OWN startup handlers.
    #
    # Anything else (Django's ASGIHandler, a bare ASGI callable) has none of
    # those hooks, so it is WRAPPED in a new ASGI app instead. That is why the
    # return value matters: for the wrap strategy the caller must bind it.
    if not isinstance(app, Starlette):
        from .asgi import VisualizedASGIApp  # local import: asgi imports us

        wrapped = VisualizedASGIApp(
            TraceMiddleware(
                app,
                correlate_request_id=correlate_request_id,
                expose_request_id=expose_request_id,
            ),
            build_viz_app(),
            monitor,
            path,
            state,
        )
        print(
            f"[fastapi_visualizer] wrapped {type(app).__name__} — assign the "
            "result, e.g. `application = visualize(application)`, or nothing "
            "is attached"
        )
        return wrapped

    try:
        app.add_middleware(
            TraceMiddleware,
            correlate_request_id=correlate_request_id,
            expose_request_id=expose_request_id,
        )
    except Exception:
        pass

    app.state._viz = state

    async def on_startup() -> None:
        await install_runtime(monitor, state)

    async def on_shutdown() -> None:
        await uninstall_runtime(monitor, state)

    # Install by WRAPPING the router's lifespan_context, not via
    # add_event_handler("startup"/"shutdown"). When the app is created with a
    # custom `lifespan=` (as FastAPI(lifespan=...)), Starlette ignores the
    # router's on_startup/on_shutdown handlers entirely — so relying on them
    # silently skips monitor install for any app that uses a custom lifespan.
    # Wrapping lifespan_context runs our setup/teardown around whatever the
    # app already does, in every configuration.
    try:
        _prev_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def _viz_lifespan(app_):
            await on_startup()
            try:
                async with _prev_lifespan(app_):
                    yield
            finally:
                await on_shutdown()

        app.router.lifespan_context = _viz_lifespan
    except Exception:
        # Fallback for older Starlette without a wrappable lifespan_context.
        try:
            app.router.add_event_handler("startup", on_startup)
            app.router.add_event_handler("shutdown", on_shutdown)
        except Exception:
            pass

    try:
        _mount_dashboard(app, path)
    except Exception:
        pass

    # Returned for symmetry with the wrap strategy, so `app = visualize(app)`
    # is correct in both cases. Existing callers that ignore it still work,
    # because this path already mutated `app` in place.
    return app
