"""Framework-agnostic entry point: wrap ANY ASGI app (Django, Quart, raw ASGI).

`visualize()` in app.py is Starlette-shaped — it calls `app.add_middleware()`,
`app.mount()`, `app.state` and `app.router.lifespan_context`, none of which
exist on a Django `ASGIHandler`. Everything *underneath* that is already
framework-agnostic: monitor.py is pure `sys.monitoring`, TraceMiddleware is
pure ASGI, and the collector knows nothing about the web layer.

So supporting other frameworks needs no new instrumentation — only a different
way to attach it. This wrapper does that composition in plain ASGI:

    django_app = get_asgi_application()
    application = visualize_asgi(django_app, enabled=True)

The returned object is itself an ASGI app that:
  - owns the `lifespan` scope (installs/uninstalls the monitor),
  - serves the dashboard for any path under `path`,
  - and passes everything else to the wrapped app through TraceMiddleware.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from . import identity, threadpool
from .app import (
    ENV_FLAG,
    _default_roots,
    _is_multi_worker,
    _normalize_mount_path,
    _resolve_enabled,
    build_viz_app,
)
from .identity import TraceMiddleware
from .monitor import Monitor


class VisualizedASGIApp:
    """ASGI app wrapping another ASGI app with the visualizer attached."""

    def __init__(self, app, viz_app, monitor, path: str, state: dict) -> None:
        self.app = app
        self.viz_app = viz_app
        self.monitor = monitor
        self.path = path
        # Django has no `app.state`; expose the same dict here instead so the
        # install can still be introspected (and asserted on in tests).
        self.state = state
        self._started = False

    # -- dashboard routing ------------------------------------------------

    def _is_viz(self, scope) -> bool:
        p = scope.get("path", "")
        return p == self.path or p.startswith(self.path + "/")

    def _sub_scope(self, scope) -> dict:
        """Re-root the scope under the mount, the way Starlette's Mount does."""
        sub = dict(scope)
        rest = scope.get("path", "")[len(self.path) :]
        sub["path"] = rest or "/"
        sub["root_path"] = scope.get("root_path", "") + self.path
        # raw_path still holds the full original path; leaving it would
        # disagree with the rewritten `path`, so drop it.
        sub.pop("raw_path", None)
        return sub

    # -- lifespan ---------------------------------------------------------

    async def _startup(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except Exception:
            return
        try:
            identity.install_task_factory(loop)
        except Exception:
            pass
        try:
            self.monitor.install()
        except Exception:
            pass
        try:
            task, stop_event = threadpool.start(loop)
            self.state["poll_task"] = task
            self.state["stop_event"] = stop_event
        except Exception:
            pass
        self._started = True

    async def _shutdown(self) -> None:
        stop_event = self.state.get("stop_event")
        poll_task = self.state.get("poll_task")
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
            self.monitor.uninstall()
        except Exception:
            pass
        try:
            identity.uninstall_task_factory(asyncio.get_running_loop())
        except Exception:
            pass

    async def _lifespan(self, scope, receive, send) -> None:
        # We own the lifespan protocol and deliberately do NOT forward it to
        # the wrapped app: Django's ASGIHandler does not implement lifespan and
        # errors on the scope (which is why uvicorn reports it as unsupported
        # for a plain Django app). A Starlette/FastAPI app has its own startup
        # handlers, so those should keep using visualize() instead of this.
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                try:
                    await self._startup()
                except Exception as exc:  # never block the app from booting
                    await send(
                        {"type": "lifespan.startup.failed", "message": str(exc)}
                    )
                    return
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                try:
                    await self._shutdown()
                except Exception:
                    pass
                await send({"type": "lifespan.shutdown.complete"})
                return

    # -- entry point ------------------------------------------------------

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "lifespan":
            await self._lifespan(scope, receive, send)
            return
        if scope["type"] in ("http", "websocket") and self._is_viz(scope):
            await self.viz_app(self._sub_scope(scope), receive, send)
            return
        await self.app(scope, receive, send)


def visualize_asgi(
    app,
    roots: list[str] | None = None,
    slow_ms: int = 100,
    enabled: bool | None = None,
    path: str = "/_viz",
    correlate_request_id: bool = False,
    expose_request_id: bool = False,
):
    """Attach the visualizer to any ASGI app and return the wrapped app.

    Unlike visualize(), this mutates nothing — it returns a new ASGI callable,
    so you must bind the result:

        application = visualize_asgi(get_asgi_application(), enabled=True)

    Note on `enabled`: auto-detection reads `app.debug`, which a Django
    ASGIHandler does not have, so a Django app resolves to OFF unless you pass
    enabled=True or export FASTAPI_VIZ=1.

    When disabled this returns the original app untouched.
    """
    if not _resolve_enabled(app, enabled):
        print(
            f"[fastapi_visualizer] disabled — set {ENV_FLAG}=1 or "
            "visualize_asgi(app, enabled=True) to enable"
        )
        return app

    path = _normalize_mount_path(path)

    if roots is None:
        roots = _default_roots()
    try:
        roots = [str(Path(r).resolve()) for r in roots]
    except Exception:
        roots = []

    if _is_multi_worker():
        print(
            "[fastapi_visualizer] running under multiple workers — the "
            "dashboard only sees the worker that served it; run a single "
            "worker to see all traffic"
        )

    monitor = Monitor(roots, slow_ms=slow_ms)
    state = {
        "enabled": True,
        "monitor": monitor,
        "poll_task": None,
        "stop_event": None,
    }

    traced = TraceMiddleware(
        app,
        correlate_request_id=correlate_request_id,
        expose_request_id=expose_request_id,
    )
    return VisualizedASGIApp(traced, build_viz_app(), monitor, path, state)
