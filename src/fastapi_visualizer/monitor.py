"""sys.monitoring (PEP 669) instrumentation: global events, filename-scoped
self-pruning, per-task call stacks that build a nested call tree.

Monitoring is installed *globally* (not per-code) for PY_START, PY_RETURN,
PY_UNWIND, PY_YIELD, PY_RESUME. Each callback checks code.co_filename against
the configured project roots before doing anything else:

  - not under any root (or under our own package dir)
    -> return sys.monitoring.DISABLE. This permanently stops the interpreter
       from calling back for that (tool, code, event) location, which is what
       keeps stdlib/site-packages/venv code from costing anything after the
       first call. (PY_UNWIND cannot be disabled this way — CPython raises if
       you try — so that callback just no-ops on out-of-root code instead.)
  - under a root but no active request (identity.current_trace() is None)
    -> return None (stay enabled, emit nothing).
  - under a root and inside a request -> record a call-tree event.

Call-tree bookkeeping uses a per-task stack of node ids (task._viz_stack) plus
a module-global monotonically increasing node id counter. When code runs
off the event loop (e.g. offloaded to the threadpool by Starlette's sync-def
handling), asyncio.current_task() is None; we fall back to a thread-local
stack there. That is only correct because anyio's threadpool workers run one
offloaded call at a time — it does not give a single stack across the
sync/async boundary of one request (see threadpool.py for the related
offload-attribution limitation).
"""

from __future__ import annotations

import asyncio
import itertools
import sys
import threading
import time
from pathlib import Path

from . import identity
from .collector import collector
from .events import (
    CALL_ENTER,
    CALL_EXIT,
    Event,
    LOOP_BLOCKED,
    LOOP_UNBLOCKED,
    OFFLOAD_END,
    OFFLOAD_START,
    RESUME,
    SUSPEND,
)

m = sys.monitoring

TOOL_NAME = "fastapi_visualizer"
# CPython code-object flags (Include/cpython/code.h). A coroutine is
# `async def`; an async generator is `async def ... yield`. BOTH run on the
# event loop and must classify as async — testing only CO_COROUTINE wrongly
# reads an async-generator dependency (e.g. FastAPI's `async def get_db: yield`)
# as sync and offloads it. CO_ASYNC = the mask covering both.
CO_COROUTINE = 0x80
CO_ASYNC_GENERATOR = 0x200
CO_ASYNC = CO_COROUTINE | CO_ASYNC_GENERATOR

_PKG_DIR = str(Path(__file__).resolve().parent)

_node_counter = itertools.count(1)
_thread_local = threading.local()


class Monitor:
    def __init__(self, roots: list[str], slow_ms: int = 100) -> None:
        self.roots = tuple(roots)
        self.enabled = False
        self.tool_id: int | None = None
        self._offloaded: set[int] = set()
        # Blocking detection (task 3). There is NO monitoring event during a
        # `time.sleep(0.3)` inside a coroutine — the monitor only sees the
        # boundary before it and the boundary after. So blocking is measured
        # retrospectively: track which in-root frame is executing on the EVENT
        # LOOP thread and since when; at the next boundary, if that frame ran
        # longer than `slow_ms` without yielding, the interval was a blocking
        # span (it froze the single loop thread). Worker-thread frames are
        # never tracked here — blocking on a worker is expected, that's the
        # whole point of the threadpool. Loop-thread-only, so these fields are
        # touched by exactly one thread and need no lock.
        self._slow = max(0.0, slow_ms / 1000.0)
        self._active_node: int | None = None
        self._active_since: float | None = None
        self._active_trace: str | None = None
        self._active_task: int | None = None
        self._active_qual: str = ""

    def _in_root(self, filename: str) -> bool:
        if filename.startswith(_PKG_DIR):
            return False
        return filename.startswith(self.roots)

    def install(self) -> None:
        for i in range(6):
            try:
                m.use_tool_id(i, TOOL_NAME)
                self.tool_id = i
                break
            except ValueError:
                continue
        else:
            print(f"[{TOOL_NAME}] no free sys.monitoring tool id, disabling")
            return

        try:
            m.register_callback(self.tool_id, m.events.PY_START, self._on_start)
            m.register_callback(self.tool_id, m.events.PY_RETURN, self._on_return)
            m.register_callback(self.tool_id, m.events.PY_UNWIND, self._on_unwind)
            m.register_callback(self.tool_id, m.events.PY_YIELD, self._on_yield)
            m.register_callback(self.tool_id, m.events.PY_RESUME, self._on_resume)
            m.set_events(
                self.tool_id,
                m.events.PY_START
                | m.events.PY_RETURN
                | m.events.PY_UNWIND
                | m.events.PY_YIELD
                | m.events.PY_RESUME,
            )
        except Exception:
            self.uninstall()
            return

        self.enabled = True

    def uninstall(self) -> None:
        if self.tool_id is None:
            return
        try:
            m.set_events(self.tool_id, 0)
        except Exception:
            pass
        for ev in (
            m.events.PY_START,
            m.events.PY_RETURN,
            m.events.PY_UNWIND,
            m.events.PY_YIELD,
            m.events.PY_RESUME,
        ):
            try:
                m.register_callback(self.tool_id, ev, None)
            except Exception:
                pass
        try:
            m.free_tool_id(self.tool_id)
        except Exception:
            pass
        self._offloaded.clear()
        self._active_node = None
        self._active_since = None
        self.tool_id = None
        self.enabled = False

    # -- per-task/per-thread call stack ---------------------------------

    def _stack(self):
        """Return (task, stack) for the currently executing call chain."""
        try:
            task = asyncio.current_task()
        except Exception:
            task = None
        if task is not None:
            stack = getattr(task, "_viz_stack", None)
            if stack is None:
                stack = []
                try:
                    task._viz_stack = stack
                except Exception:
                    pass
            return task, stack
        # Not running on an asyncio task: likely offloaded threadpool work.
        stack = getattr(_thread_local, "stack", None)
        if stack is None:
            stack = []
            _thread_local.stack = stack
        return None, stack

    def _push(self, kind: str, task, name: str, extra: dict) -> None:
        try:
            collector.push(
                Event(
                    t=time.monotonic(),
                    kind=kind,
                    trace_id=identity.current_trace(),
                    task_id=id(task) if task is not None else None,
                    name=name,
                    extra=extra,
                )
            )
        except Exception:
            pass

    # -- blocking detection (loop thread only) ---------------------------

    def _loop_close(self, now: float) -> None:
        """Close the current loop-frame interval; flag it if it ran too long.

        Emits a loop_blocked (stamped at the interval START) + loop_unblocked
        (stamped NOW) pair when the frame held the single loop thread for
        longer than `slow_ms` without yielding. Stamping the pair at the real
        span boundaries lets the slow-motion frontend hold the node red for the
        (dilated) block duration.
        """
        node = self._active_node
        since = self._active_since
        self._active_node = None
        self._active_since = None
        if node is None or since is None or self._slow <= 0:
            return
        dur = now - since
        if dur < self._slow:
            return
        extra = {
            "node_id": node,
            "qualname": self._active_qual,
            "duration_ms": round(dur * 1000),
        }
        try:
            collector.push(
                Event(
                    t=since,
                    kind=LOOP_BLOCKED,
                    trace_id=self._active_trace,
                    task_id=self._active_task,
                    name=self._active_qual,
                    extra=extra,
                )
            )
            collector.push(
                Event(
                    t=now,
                    kind=LOOP_UNBLOCKED,
                    trace_id=self._active_trace,
                    task_id=self._active_task,
                    name=self._active_qual,
                    extra=dict(extra),
                )
            )
        except Exception:
            pass

    def _loop_open(self, node_id: int, now: float, task, qual: str) -> None:
        self._active_node = node_id
        self._active_since = now
        self._active_task = id(task) if task is not None else None
        self._active_trace = identity.current_trace()
        self._active_qual = qual

    # -- callbacks --------------------------------------------------------

    def _on_start(self, code, instruction_offset):
        try:
            if not self._in_root(code.co_filename):
                return m.DISABLE
        except Exception:
            return m.DISABLE
        try:
            if identity.current_trace() is None:
                return
            task, stack = self._stack()
            # Stack entries are (node_id, qualname) so a frame re-opened after a
            # child returns (see _on_exit) can name itself in a loop_blocked
            # event instead of emitting a blank qualname.
            parent_id = stack[-1][0] if stack else None
            node_id = next(_node_counter)
            now = time.monotonic()
            # On the loop thread, calling this child is a boundary for the
            # PARENT frame: close its interval (it ran from its own start/resume
            # until now), then open one for the child we're entering.
            if task is not None:
                self._loop_close(now)
            stack.append((node_id, code.co_qualname))
            is_async = bool(code.co_flags & CO_ASYNC)
            # True threadpool signal: code running with NO current asyncio task
            # is on an anyio worker thread (that's exactly where _stack() falls
            # back to the thread-local stack). This replaces the old
            # `parent_id is None and not is_async` guess, which misfired on
            # loop-run async generators. Async work always has a current task,
            # so it can never be mislabeled as offloaded now.
            is_worker = task is None
            execution = "threadpool" if is_worker else "event_loop"
            self._push(
                CALL_ENTER,
                task,
                code.co_qualname,
                {
                    "node_id": node_id,
                    "parent_id": parent_id,
                    "qualname": code.co_qualname,
                    "file": code.co_filename,
                    "line": code.co_firstlineno,
                    "is_async": is_async,
                    "execution": execution,
                },
            )
            # Mark the ROOT frame of a worker-thread call chain as offloaded
            # (parent_id None = top of this thread's stack), wrapping the whole
            # offloaded subtree in one offload_start/offload_end pair.
            if is_worker and parent_id is None:
                self._offloaded.add(node_id)
                self._push(OFFLOAD_START, task, code.co_qualname, {"node_id": node_id})
            if task is not None:
                self._loop_open(node_id, now, task, code.co_qualname)
        except Exception:
            pass

    def _on_exit(self, code):
        try:
            if identity.current_trace() is None:
                return
            task, stack = self._stack()
            if not stack:
                return
            node_id, _qual = stack.pop()
            now = time.monotonic()
            # Returning is a boundary for THIS frame: close its interval, then
            # re-open one for the parent that now regains control, naming it
            # from the stack entry's qualname. Empty stack -> nothing runs
            # in-root next.
            if task is not None:
                self._loop_close(now)
            self._push(CALL_EXIT, task, code.co_qualname, {"node_id": node_id})
            if node_id in self._offloaded:
                self._offloaded.discard(node_id)
                self._push(OFFLOAD_END, task, code.co_qualname, {"node_id": node_id})
            if task is not None and stack:
                parent_id, parent_qual = stack[-1]
                self._loop_open(parent_id, now, task, parent_qual)
        except Exception:
            pass

    def _on_return(self, code, instruction_offset, retval):
        try:
            if not self._in_root(code.co_filename):
                return m.DISABLE
        except Exception:
            return m.DISABLE
        self._on_exit(code)

    def _on_unwind(self, code, instruction_offset, exc):
        # PY_UNWIND cannot be disabled via the DISABLE return value (raises
        # ValueError if attempted), unlike the other events here — just skip
        # bookkeeping for out-of-root code instead.
        try:
            if not self._in_root(code.co_filename):
                return
        except Exception:
            return
        self._on_exit(code)

    def _on_yield(self, code, instruction_offset, retval):
        try:
            if not self._in_root(code.co_filename):
                return m.DISABLE
        except Exception:
            return m.DISABLE
        try:
            if identity.current_trace() is None:
                return
            task, stack = self._stack()
            if not stack:
                return
            node_id = stack[-1][0]
            # Yielding the loop closes the interval (this catches sync/CPU work
            # done BEFORE the await — still a blocking span) and leaves nothing
            # in-root running: the loop now runs the await / other tasks, so the
            # wait time is NOT attributed to any frame.
            if task is not None:
                self._loop_close(time.monotonic())
            self._push(
                SUSPEND, task, code.co_qualname, {"node_id": node_id, "awaiting": code.co_qualname}
            )
        except Exception:
            pass

    def _on_resume(self, code, instruction_offset):
        try:
            if not self._in_root(code.co_filename):
                return m.DISABLE
        except Exception:
            return m.DISABLE
        try:
            if identity.current_trace() is None:
                return
            task, stack = self._stack()
            if not stack:
                return
            node_id = stack[-1][0]
            now = time.monotonic()
            self._push(RESUME, task, code.co_qualname, {"node_id": node_id})
            # Resuming re-establishes this frame as the one running on the loop.
            # No _loop_close first: _on_yield already closed the prior interval
            # (set _active_node = None), and the wait since then was
            # await/scheduling time we deliberately leave un-attributed.
            if task is not None:
                self._loop_open(node_id, now, task, code.co_qualname)
        except Exception:
            pass
