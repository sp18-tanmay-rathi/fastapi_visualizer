"""The wrap-strategy ASGI app used by visualize() for non-Starlette apps.

`visualize()` in app.py is Starlette-shaped — it calls `app.add_middleware()`,
`app.mount()`, `app.state` and `app.router.lifespan_context`, none of which
exist on a Django `ASGIHandler`. Everything *underneath* that is already
framework-agnostic: monitor.py is pure `sys.monitoring`, TraceMiddleware is
pure ASGI, and the collector knows nothing about the web layer.

So supporting other frameworks needs no new instrumentation — only a different
way to attach it. `visualize()` detects that and returns one of these instead
of mutating the app:

    application = visualize(get_asgi_application(), enabled=True)

The returned object is itself an ASGI app that:
  - owns the `lifespan` scope (installs/uninstalls the monitor),
  - serves the dashboard for any path under `path`,
  - and passes everything else to the wrapped app through TraceMiddleware.
"""

from __future__ import annotations

import asyncio

from .app import install_runtime, uninstall_runtime


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
        await install_runtime(self.monitor, self.state)
        self._started = True

    async def _shutdown(self) -> None:
        await uninstall_runtime(self.monitor, self.state)

    async def _lifespan(self, scope, receive, send) -> None:
        # We own the lifespan protocol and deliberately do NOT forward it to
        # the wrapped app: Django's ASGIHandler does not implement lifespan and
        # errors on the scope (which is why uvicorn reports it as unsupported
        # for a plain Django app). A Starlette app has its own startup handlers
        # to preserve, which is exactly why visualize() mutates those in place
        # (wrapping their lifespan_context) rather than routing them here.
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
