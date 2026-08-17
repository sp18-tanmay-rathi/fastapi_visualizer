"""visualize(app): attaches instrumentation and mounts the /_viz dashboard."""

from __future__ import annotations

import asyncio
import sys
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
        await websocket.accept()
        queue = collector.subscribe()
        try:
            backlog = [e.to_dict() for e in collector.snapshot()]
            await websocket.send_json({"events": backlog})
            while True:
                batch = [await queue.get()]
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
            collector.unsubscribe(queue)

    viz_app = Starlette(
        routes=[
            Route("/", index),
            Route("/dashboard.js", dashboard_js),
            WebSocketRoute("/ws", ws_endpoint),
        ]
    )
    app.mount("/_viz", viz_app)


def visualize(app, roots: list[str] | None = None) -> None:
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

    monitor = Monitor(roots)
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

    # FastAPI/Starlette removed add_event_handler from the app itself in
    # favor of lifespan context managers; the Router still exposes it for
    # backward compatibility, which is what this relies on.
    app.router.add_event_handler("startup", on_startup)
    app.router.add_event_handler("shutdown", on_shutdown)

    try:
        _mount_dashboard(app)
    except Exception:
        pass
