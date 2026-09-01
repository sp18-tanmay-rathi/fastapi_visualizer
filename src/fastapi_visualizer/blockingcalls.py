"""Catches a blocking call by WHAT IT IS, not by how long it took.

The stopwatch in monitor.py and the watchdog in watchdog.py both answer "was the
loop held too long?". Neither can see the mistake that has not hurt yet:

    async def handler():
        row = cursor.execute("select 1").fetchone()   # 3ms on your laptop

That is the same defect as `time.sleep(0.3)` — the loop thread waited on the
outside world instead of yielding — but no threshold will ever catch it. It
becomes an outage the day the database slows down.

So ask a different question: *did the loop thread do something it is never
allowed to do?* An event-loop thread should only ever block in its own
selector. Any other wait on the outside world is wrong at 1ms, and that is a
yes/no test rather than a threshold.

We answer it with `sys.addaudithook`. Python already announces a set of
security-relevant operations, several of which are exactly the ones that block:
opening a file, connecting a socket, resolving a hostname, spawning a process,
opening a database. Listening costs nothing at the call site and — unlike
swapping out stdlib functions, which is what BlockBuster does — it never
changes how anybody's code behaves. That matters here: this tool's contract is
that it observes and does not alter.

HONEST GAPS, because this method cannot be complete:

  - There is no audit event for `socket.recv`/`send` or for `time.sleep`. So a
    connection is caught at connect time, not at every subsequent read. In
    practice that is enough to identify the offending call site, which is what
    you need in order to fix it.
  - An audit hook CANNOT be removed once installed (CPython offers no API).
    `install()` therefore adds the hook at most once per process and everything
    afterwards is gated on a flag, so uninstall() makes it inert rather than
    absent.
  - Only the loop thread is judged. The identical call on a worker thread is
    correct by design — that is what a threadpool is for.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

from . import identity
from .collector import collector
from .events import BLOCKING_CALL, Event
from .monitor import _LIB_MARKERS, _LIB_PREFIXES

_PKG_DIR = str(Path(__file__).resolve().parent)

# Importing a module opens its source file, and a lazy import fires on the loop
# thread inside whatever request happened to trigger it — anyio loads its
# worker-thread machinery on the first run_in_threadpool call, for instance.
# Those are not application I/O, and reporting them would blame a request for
# the interpreter's own bookkeeping.
_IMPORT_SUFFIXES = (".py", ".pyc", ".pyo", ".pyd", ".so")

# audit event -> (category, index of the argument worth showing)
AUDITED: dict[str, tuple[str, int | None]] = {
    "open": ("file", 0),
    "socket.connect": ("socket", None),
    "socket.getaddrinfo": ("dns", 0),
    "socket.gethostbyname": ("dns", 0),
    "subprocess.Popen": ("subprocess", 0),
    "os.system": ("subprocess", 0),
    "sqlite3.connect": ("database", 0),
    "urllib.Request": ("http", 0),
}

_MAX_DETAIL = 120
# The dedup set is keyed per REQUEST, so it grows by roughly one entry per
# blocking call per request and never shrinks on its own — a slow leak over a
# long dev session. Drop it wholesale past this size; the only cost is that a
# call already reported for a still-open request might be reported once more.
_MAX_SEEN = 4096


class BlockingCallDetector:
    def __init__(self, monitor=None) -> None:
        self.monitor = monitor
        self.enabled = False
        self.loop_tid: int | None = None
        self._hook_installed = False
        # Emitting an event can itself trip audited operations; without this a
        # single open() could recurse until the stack blows.
        self._local = threading.local()
        # One report per (category, detail) per request is plenty. A handler in
        # a loop would otherwise emit thousands of identical events and shove
        # everything else out of the bounded buffer.
        self._seen: set[tuple] = set()

    # -- lifecycle --------------------------------------------------------

    def install(self, loop_tid: int) -> None:
        self.loop_tid = loop_tid
        self.enabled = True
        self._seen.clear()
        if self._hook_installed:
            return  # audit hooks are permanent; re-arming the flag is enough
        try:
            sys.addaudithook(self._hook)
            self._hook_installed = True
        except Exception:
            self.enabled = False

    def uninstall(self) -> None:
        # The hook stays registered (CPython has no way to remove one), so make
        # it a no-op instead.
        self.enabled = False
        self._seen.clear()

    # -- the hook ---------------------------------------------------------

    def _hook(self, event: str, args) -> None:
        if not self.enabled:
            return
        info = AUDITED.get(event)
        if info is None:
            return
        if getattr(self._local, "busy", False):
            return
        try:
            # Only the event-loop thread can be guilty. The same call on a
            # worker thread is exactly what offloading is for.
            if threading.get_ident() != self.loop_tid:
                return
            trace = identity.current_trace()
            if trace is None:
                return  # not inside a request: startup, imports, background work

            category, arg_index = info
            raw = ""
            if arg_index is not None and len(args) > arg_index:
                raw = str(args[arg_index])

            # Filter on the FULL value, then truncate only for display. Doing
            # it the other way round silently broke the import filter: a path
            # longer than _MAX_DETAIL lost its ".py" suffix to the truncation
            # and was reported as application I/O.
            #
            # Don't report ourselves: serving the dashboard opens files on the
            # loop thread inside a traced request, which is us, not the app.
            if raw.startswith(_PKG_DIR):
                return
            if category == "file" and self._is_import(raw):
                return

            detail = raw[:_MAX_DETAIL]

            key = (trace, category, detail)
            if key in self._seen:
                return
            if len(self._seen) >= _MAX_SEEN:
                self._seen.clear()
            self._seen.add(key)

            self._local.busy = True
            try:
                self._emit(category, event, detail, trace)
            finally:
                self._local.busy = False
        except Exception:
            try:
                self._local.busy = False
            except Exception:
                pass

    @staticmethod
    def _is_import(path: str) -> bool:
        """An interpreter import rather than the application reading a file."""
        if path.endswith(_IMPORT_SUFFIXES):
            return True
        if path.startswith(_LIB_PREFIXES):
            return True
        for marker in _LIB_MARKERS:
            if marker in path:
                return True
        return "__pycache__" in path

    def _emit(self, category: str, event: str, detail: str, trace: str) -> None:
        node = qual = None
        try:
            if self.monitor is not None:
                node = self.monitor._active_node
                qual = self.monitor._active_qual
        except Exception:
            pass
        try:
            collector.push(
                Event(
                    t=time.monotonic(),
                    kind=BLOCKING_CALL,
                    trace_id=trace,
                    task_id=None,
                    name=qual or category,
                    extra={
                        "category": category,
                        "audit_event": event,
                        "detail": detail,
                        "node_id": node,
                        "qualname": qual,
                    },
                )
            )
        except Exception:
            pass


def start(loop_tid: int, monitor=None) -> BlockingCallDetector:
    d = BlockingCallDetector(monitor=monitor)
    d.install(loop_tid)
    return d
