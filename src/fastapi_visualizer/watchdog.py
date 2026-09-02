"""Detects a frozen event loop from OUTSIDE the loop, while it is still frozen.

`monitor.py` measures blocking retrospectively: it times each in-root frame
between `sys.monitoring` boundaries and judges it at the *next* boundary. That
cannot report a stall while it is happening, and cannot report one at all if
the frame never reaches another boundary:

    GET /freeze  (time.sleep(2.0) inside an async def)
      t+0.0s .. t+1.9s   loop frozen, zero events emitted
      t+2.0s             one loop_blocked, after it is over

A frame that hangs forever therefore produces nothing, ever — the worst case
is the silent one.

So don't ask the frozen thread whether it is frozen; ask someone else:

    event loop thread            watchdog thread (daemon)
    ─────────────────            ────────────────────────
    every `interval`:            every `interval`:
      last_tick = now()            gap = now() - last_tick
                                   gap > stall_ms  ->  the loop is stuck NOW
       [ FROZEN ]                    snapshot its stack, emit loop_stalled
       heartbeat stops

Two properties fall out of measuring loop *responsiveness* rather than a
frame's duration:

  - Detection latency is the threshold, not the operation's length. A five
    minute freeze is reported in the first fraction of a second.
  - `await`s never false-positive. `await asyncio.sleep(300)` or
    `await run_in_threadpool(slow_fn)` leave the loop free, so the heartbeat
    keeps ticking and nothing fires. Measured: a 1.5s operation shows a worst
    heartbeat gap of ~55ms when awaited, ~1548ms when called inline.

The stack snapshot comes from `sys._current_frames()`, which returns the loop
thread's WHOLE stack — including library frames outside `roots` that the
monitor never sees. That turns "your handler was slow" into "your handler is
stuck in socket.recv".

WHAT THIS DOES NOT DO: reach the browser during the stall. The event is
recorded here immediately, but delivery to the dashboard runs through
`collector.push` -> `loop.call_soon_threadsafe` -> WebSocket send, every step of
which needs the event loop that is currently frozen. Measured: a 3.0s freeze is
detected at ~0.28s but does not reach a connected client until 3.09s, when the
loop recovers. So this improves WHAT is reported (start time, duration, full
stack, and a permanent hang recorded at all) rather than WHEN the browser hears
about it. Live alerting would need a delivery path that does not touch the loop
— a second connection served from its own thread. See
docs/plans/blocking-detection-v2.md.

Limitation, deliberately not hidden: the watchdog needs the blocked thread to
release the GIL at some point. True for syscalls, and for CPU-bound Python via
the interpreter's switch interval — but a C extension that holds the GIL
outright starves this thread. That case is still covered by monitor.py's
boundary timing, which is why this ADDS to it rather than replacing it.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time

from .collector import collector
from .events import Event, LOOP_STALLED, LOOP_UNSTALLED

# Deepest frames are the interesting ones; cap the payload so a runaway
# recursion can't push a megabyte of stack through the WebSocket.
MAX_STACK_FRAMES = 40
# How many of the deepest frames to put in the log line. The outer frames are
# server plumbing; the interesting part is always the bottom of the stack.
LOG_FRAMES = 6

_log = logging.getLogger("fastapi_visualizer")


class Watchdog:
    def __init__(self, stall_ms: int = 250, interval: float = 0.05, monitor=None) -> None:
        # The threshold must sit comfortably above `interval`: a healthy loop
        # still shows gaps of roughly one interval, because that is how often
        # the heartbeat runs.
        self.stall_ms = max(0, stall_ms)
        self.interval = interval
        self.monitor = monitor  # optional, for trace/node attribution
        self._last_tick = 0.0
        self._loop_tid: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._hb_task: asyncio.Task | None = None
        self._stalled = False
        self._stall_since = 0.0

    # -- lifecycle --------------------------------------------------------

    def start(self, loop) -> None:
        """Must be called ON the event-loop thread (its id is captured here)."""
        if self.stall_ms <= 0:
            return  # disabled
        try:
            self._loop_tid = threading.get_ident()
            self._last_tick = time.monotonic()
            self._hb_task = loop.create_task(self._heartbeat())
            self._thread = threading.Thread(
                target=self._watch, name="fastapi-visualizer-watchdog", daemon=True
            )
            self._thread.start()
        except Exception:
            pass

    def stop(self) -> None:
        # Close out a stall that is still open, so the dashboard cannot be left
        # showing a permanently frozen loop after teardown. Also covers the
        # narrow case where the loop recovered just before shutdown and the
        # watchdog had no poll left in which to notice.
        if self._stalled:
            try:
                self._stalled = False
                self._emit_unstalled(time.monotonic())
            except Exception:
                pass
        try:
            self._stop.set()
        except Exception:
            pass
        task = self._hb_task
        if task is not None:
            try:
                task.cancel()
            except Exception:
                pass
        thread = self._thread
        if thread is not None:
            try:
                thread.join(timeout=1)
            except Exception:
                pass
        self._thread = None
        self._hb_task = None
        self._stalled = False

    # -- the two halves ---------------------------------------------------

    async def _heartbeat(self) -> None:
        """Runs on the loop. Its silence is the whole signal."""
        try:
            while not self._stop.is_set():
                self._last_tick = time.monotonic()
                await asyncio.sleep(self.interval)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    def _watch(self) -> None:
        """Runs on its own thread, so it can look while the loop cannot."""
        while not self._stop.wait(self.interval):
            try:
                now = time.monotonic()
                gap_ms = (now - self._last_tick) * 1000
                if not self._stalled and gap_ms >= self.stall_ms:
                    self._stalled = True
                    # Date the stall from the last healthy beat, not from now:
                    # it began when the heartbeat stopped, which is up to one
                    # interval before we noticed.
                    self._stall_since = self._last_tick
                    self._emit_stalled(now)
                elif self._stalled and gap_ms < self.stall_ms:
                    self._stalled = False
                    self._emit_unstalled(now)
            except Exception:
                pass  # a watchdog must never take the app down

    # -- stack capture ----------------------------------------------------

    def _loop_stack(self) -> list[dict]:
        """The loop thread's live Python stack, outermost frame first."""
        frames: list[dict] = []
        try:
            frame = sys._current_frames().get(self._loop_tid)
        except Exception:
            return frames
        try:
            while frame is not None and len(frames) < MAX_STACK_FRAMES:
                code = frame.f_code
                frames.append(
                    {
                        "qualname": getattr(code, "co_qualname", code.co_name),
                        "file": code.co_filename,
                        "line": frame.f_lineno,
                    }
                )
                frame = frame.f_back
        except Exception:
            pass
        frames.reverse()
        return frames

    def _in_root(self, path: str) -> bool:
        try:
            return bool(self.monitor) and self.monitor._in_root(path)
        except Exception:
            return False

    def _culprit(self, stack: list[dict]) -> str:
        """Best label for the stall: the deepest frame that is the app's own.

        The deepest frame overall is usually `time.sleep` or `socket.recv`,
        which says what it is doing but not who asked for it. The deepest
        in-root frame is the line the developer can actually change.
        """
        for entry in reversed(stack):
            if self._in_root(entry.get("file", "")):
                return entry.get("qualname", "?")
        return stack[-1].get("qualname", "?") if stack else "?"

    # -- events -----------------------------------------------------------

    def _push(self, kind: str, t: float, extra: dict) -> None:
        # Attribution comes from ONE atomic snapshot, not from reading the
        # monitor's per-frame fields one at a time from this thread. Two
        # separate reads could straddle a frame boundary and pair one frame's
        # node with another's trace; and before `_loop_close` learned to clear
        # the trace, an unowned freeze inherited whichever request last ran an
        # in-root frame — routinely one that had already finished.
        #
        # `None` here is the correct answer for a freeze in library or
        # framework code: the event still carries the stack, which is what
        # actually identifies the culprit, and no request gets blamed for a
        # stall that is not provably its own.
        trace = node = None
        try:
            if self.monitor is not None:
                snap = self.monitor.active_frame()
                if snap is not None:
                    node, trace, _qual = snap
        except Exception:
            pass
        try:
            collector.push(
                Event(
                    t=t,
                    kind=kind,
                    trace_id=trace,
                    task_id=None,
                    name=extra.get("qualname", "loop"),
                    extra=dict(extra, node_id=node),
                )
            )
        except Exception:
            pass

    def _log_stall(self, stack: list[dict], culprit: str, held_ms: int) -> None:
        """Report to the log immediately, from this thread.

        The dashboard cannot be told while the loop is frozen — the WebSocket
        send runs on the very loop that is stuck (see the module docstring). The
        log has no such problem: it is written from this thread and does not
        touch the loop. So when a request hangs and the dashboard goes quiet,
        the terminal still tells you what it is stuck in, which is where you
        would be looking anyway.
        """
        try:
            lines = [
                "  %s  %s:%s" % (f["qualname"], f["file"], f["line"])
                for f in stack[-LOG_FRAMES:]
            ]
            _log.warning(
                "event loop stalled %dms and is still stuck, in %s\n%s",
                held_ms,
                culprit,
                "\n".join(lines),
            )
        except Exception:
            pass

    def _emit_stalled(self, now: float) -> None:
        stack = self._loop_stack()
        self._log_stall(stack, self._culprit(stack), round((now - self._stall_since) * 1000))
        self._push(
            LOOP_STALLED,
            self._stall_since,
            {
                "qualname": self._culprit(stack),
                "stack": stack,
                "detected_after_ms": round((now - self._stall_since) * 1000),
            },
        )

    def _emit_unstalled(self, now: float) -> None:
        try:
            _log.warning(
                "event loop recovered after %dms", round((now - self._stall_since) * 1000)
            )
        except Exception:
            pass
        self._push(
            LOOP_UNSTALLED,
            now,
            {"duration_ms": round((now - self._stall_since) * 1000)},
        )


def start(loop, stall_ms: int = 250, monitor=None) -> Watchdog:
    wd = Watchdog(stall_ms=stall_ms, monitor=monitor)
    wd.start(loop)
    return wd
