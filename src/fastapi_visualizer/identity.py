"""Request identity: trace ids propagated via contextvar + Task attribute.

Pure-ASGI middleware is used (not BaseHTTPMiddleware) because the latter is
known to break contextvar propagation upward through the stack.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from contextvars import ContextVar

from .collector import collector
from .events import Event, REQUEST_END, REQUEST_START

trace_id_var: ContextVar[str | None] = ContextVar("trace_id_var", default=None)


def _next_trace_id() -> str:
    # Short random id per request (6 hex chars). Unique enough to tell
    # concurrent requests apart in the dashboard; not a security token.
    return secrets.token_hex(3)


class TraceMiddleware:
    def __init__(self, app, **kwargs) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        tid = _next_trace_id()
        token = trace_id_var.set(tid)
        try:
            task = asyncio.current_task()
        except Exception:
            task = None
        if task is not None:
            try:
                task._viz_trace = tid
                task._viz_stack = []
            except Exception:
                pass

        try:
            collector.push(
                Event(
                    t=time.monotonic(),
                    kind=REQUEST_START,
                    trace_id=tid,
                    task_id=id(task) if task is not None else None,
                    name=scope.get("path", ""),
                    extra={"method": scope.get("method", ""), "path": scope.get("path", "")},
                )
            )
        except Exception:
            pass

        try:
            await self.app(scope, receive, send)
        finally:
            try:
                collector.push(
                    Event(
                        t=time.monotonic(),
                        kind=REQUEST_END,
                        trace_id=tid,
                        task_id=id(task) if task is not None else None,
                        name=scope.get("path", ""),
                    )
                )
            except Exception:
                pass
            trace_id_var.reset(token)


def install_task_factory(loop) -> None:
    """Wrap loop's task factory so child tasks inherit the parent's trace id."""
    try:
        prev_factory = loop.get_task_factory()
    except Exception:
        prev_factory = None
    loop._viz_prev_factory = prev_factory

    def factory(loop_, coro, **kwargs):
        try:
            creator = asyncio.current_task()
        except Exception:
            creator = None
        try:
            if prev_factory is not None:
                task = prev_factory(loop_, coro, **kwargs)
            else:
                task = asyncio.Task(coro, loop=loop_, **kwargs)
        except Exception:
            task = asyncio.Task(coro, loop=loop_, **kwargs)
        try:
            if creator is not None:
                trace = getattr(creator, "_viz_trace", None)
                if trace is not None:
                    task._viz_trace = trace
                    task._viz_stack = []  # child task gets its own branch stack
        except Exception:
            pass
        return task

    try:
        loop.set_task_factory(factory)
    except Exception:
        pass


def uninstall_task_factory(loop) -> None:
    prev_factory = getattr(loop, "_viz_prev_factory", None)
    try:
        loop.set_task_factory(prev_factory)
    except Exception:
        pass


def current_trace() -> str | None:
    try:
        task = asyncio.current_task()
        trace = getattr(task, "_viz_trace", None) if task is not None else None
        if trace is not None:
            return trace
    except Exception:
        pass
    try:
        return trace_id_var.get()
    except Exception:
        return None
