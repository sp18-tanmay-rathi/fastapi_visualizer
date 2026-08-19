"""visualize(app): attaches instrumentation and mounts the /_viz dashboard."""

from __future__ import annotations

import asyncio
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


def _default_roots() -> list[str]:
    """Directory of the module that called visualize(), as a trace root."""
    try:
        caller_file = sys._getframe(2).f_globals.get("__file__")
        if caller_file:
            return [str(Path(caller_file).resolve().parent)]
    except Exception:
        pass
    return []


def _mount_dashboard(app) -> None:
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
            await websocket.send_json({"events": backlog})
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

    viz_app = Starlette(
        routes=[
            Route("/", index),
            Route("/dashboard.js", dashboard_js),
            WebSocketRoute("/ws", ws_endpoint),
        ]
    )
    app.mount("/_viz", viz_app)


def visualize(app, roots: list[str] | None = None, slow_ms: int = 100) -> None:
    if roots is None:
        roots = _default_roots()
    try:
        roots = [str(Path(r).resolve()) for r in roots]
    except Exception:
        roots = []

    try:
        app.add_middleware(TraceMiddleware)
    except Exception:
        pass

    monitor = Monitor(roots, slow_ms=slow_ms)
    state = {"monitor": monitor, "poll_task": None, "stop_event": None}
    app.state._viz = state

    async def on_startup() -> None:
        try:
            loop = asyncio.get_running_loop()
        except Exception:
            return
        try:
            loop.set_debug(True)
        except Exception:
            pass
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

    async def on_shutdown() -> None:
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
        _mount_dashboard(app)
    except Exception:
        pass
