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

REQUEST_ID_HEADER = b"x-request-id"
# Characters allowed in a correlated (externally supplied) trace id. An inbound
# header is attacker-controlled, and the id is rendered in the dashboard and
# used as a dict key, so it is filtered rather than trusted verbatim.
_ID_SAFE = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
)
_ID_MAXLEN = 64


def _next_trace_id() -> str:
    # 16 hex chars. Wide enough that concurrent requests under real load don't
    # collide (the old 6-char id was fine for a demo, not for a busy app); the
    # dashboard still DISPLAYS a short prefix and keeps the full id in the
    # request inspector.
    return secrets.token_hex(8)


def _header(scope, name: bytes) -> str | None:
    try:
        for key, value in scope.get("headers") or ():
            if key.lower() == name:
                return value.decode("latin-1")
    except Exception:
        pass
    return None


def _sanitize_id(raw: str | None) -> str | None:
    if not raw:
        return None
    cleaned = "".join(ch for ch in raw if ch in _ID_SAFE)[:_ID_MAXLEN]
    return cleaned or None


class TraceMiddleware:
    def __init__(
        self,
        app,
        correlate_request_id: bool = False,
        expose_request_id: bool = False,
        **kwargs,
    ) -> None:
        self.app = app
        self.correlate_request_id = correlate_request_id
        self.expose_request_id = expose_request_id

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # An inbound X-Request-ID is always RECORDED (the inspector shows it so
        # a dashboard row can be matched against an upstream log), but it only
        # REPLACES our generated trace id when correlation is explicitly turned
        # on — an unconfigured app should never let a client choose its own id.
        inbound = _sanitize_id(_header(scope, REQUEST_ID_HEADER))
        tid = inbound if (self.correlate_request_id and inbound) else _next_trace_id()

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

        t0 = time.monotonic()
        try:
            collector.push(
                Event(
                    t=t0,
                    kind=REQUEST_START,
                    trace_id=tid,
                    task_id=id(task) if task is not None else None,
                    name=scope.get("path", ""),
                    extra={
                        "method": scope.get("method", ""),
                        "path": scope.get("path", ""),
                        "request_id": inbound,
                    },
                )
            )
        except Exception:
            pass

        # Observe the response status by wrapping `send` and reading
        # http.response.start. This deliberately does NOT touch or buffer
        # response bodies — status is all we need, and buffering would change
        # streaming behavior.
        status: int | None = None

        async def send_wrapper(message):
            nonlocal status
            try:
                if message.get("type") == "http.response.start":
                    status = message.get("status")
                    if self.expose_request_id:
                        headers = list(message.get("headers") or [])
                        headers.append(
                            (REQUEST_ID_HEADER, tid.encode("latin-1", "ignore"))
                        )
                        message = dict(message)
                        message["headers"] = headers
            except Exception:
                pass
            await send(message)

        error: str | None = None
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            # Record that the request failed, then re-raise: the visualizer must
            # never swallow an application exception.
            error = type(exc).__name__
            raise
        finally:
            try:
                now = time.monotonic()
                extra: dict = {
                    "status": status,
                    "duration_ms": round((now - t0) * 1000),
                }
                if error is not None:
                    extra["error"] = error
                collector.push(
                    Event(
                        t=now,
                        kind=REQUEST_END,
                        trace_id=tid,
                        task_id=id(task) if task is not None else None,
                        name=scope.get("path", ""),
                        extra=extra,
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
