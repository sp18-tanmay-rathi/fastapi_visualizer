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
import weakref
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

# ---------------------------------------------------------------------------
# One audit hook per PROCESS, not one per app.
#
# `sys.addaudithook` is permanent — CPython offers no way to remove a hook. A
# per-detector hook therefore leaked one more permanent callback on every app
# startup, each firing on every audited event for the rest of the process.
# Measured before this: four apps in one interpreter left four hooks; the test
# suite starts far more than four. So a single dispatcher is installed once and
# fans out to whichever detectors are currently live.
#
# The registry is weak: an app dropped without a clean shutdown takes its
# detector with it instead of pinning it forever. Live apps hold a strong
# reference in `app.state._viz["blocking_calls"]`.
_HOOK_LOCK = threading.Lock()
_HOOK_INSTALLED = False
# Membership. Mutated only under _HOOK_LOCK.
_ACTIVE: "weakref.WeakSet[BlockingCallDetector]" = weakref.WeakSet()
# What `_dispatch` actually reads: an immutable tuple of weak references,
# replaced by whole-object assignment. Building the snapshot inside the hook
# instead — `tuple(_ACTIVE)` — races with `add()`/`discard()` from another
# thread and raises `RuntimeError: Set changed size during iteration`
# (measured: 56 times in 2s under a tight add/discard loop). Weak references
# rather than the detectors themselves, so a dropped app is still collectable.
_DISPATCH: "tuple[weakref.ref, ...]" = ()


def _refresh_dispatch() -> None:
    """Rebuild the dispatch snapshot. The caller must hold `_HOOK_LOCK`."""
    global _DISPATCH
    _DISPATCH = tuple(weakref.ref(d) for d in _ACTIVE)


def _dispatch(event: str, args) -> None:
    """The one process-wide audit hook. Must never raise.

    The outer guard is the important one. This runs as the `sys.addaudithook`
    callback, so anything escaping it is raised *inside whatever audited call
    happened to trigger it* — a plain `open()` in application code, on
    whatever thread that call was on — not politely logged. Verified: a hook
    that raises makes an unrelated `open()` fail with the hook's own
    exception. Hence the project rule that every instrumentation path is
    fail-soft.

    No lock here on purpose: this is the hottest path in the process (the
    interpreter raises audit events for every library in it, and the hook
    already costs ~20% of throughput), so it takes one atomic read of an
    immutable tuple instead.
    """
    try:
        for ref in _DISPATCH:
            detector = ref()
            if detector is None:
                continue  # its app was dropped; the next refresh drops the ref
            try:
                detector._hook(event, args)
            except Exception:
                pass
    except Exception:
        pass


def _ensure_hook() -> bool:
    global _HOOK_INSTALLED
    with _HOOK_LOCK:
        if _HOOK_INSTALLED:
            return True
        try:
            sys.addaudithook(_dispatch)
        except Exception:
            return False
        _HOOK_INSTALLED = True
        return True


class BlockingCallDetector:
    def __init__(self, monitor=None) -> None:
        self.monitor = monitor
        self.enabled = False
        self.loop_tid: int | None = None
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
        self._seen.clear()
        if not _ensure_hook():
            self.enabled = False
            return
        self.enabled = True
        with _HOOK_LOCK:
            _ACTIVE.add(self)
            _refresh_dispatch()

    def uninstall(self) -> None:
        # The process-wide hook stays registered (CPython has no way to remove
        # one), but this detector stops being dispatched to at all.
        self.enabled = False
        self._seen.clear()
        with _HOOK_LOCK:
            _ACTIVE.discard(self)
            _refresh_dispatch()

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

            # A request is in flight, but is any of the USER's code actually on
            # the stack? If not, this call belongs to library or framework
            # internals and cannot be pinned on a frame anyone can change.
            #
            # The case that forced this: Django imports its URLconf lazily, on
            # the first request to arrive. That pulled in reportlab, which
            # reads ~/.reportlab_settings at import time — a genuine blocking
            # read on the loop thread, but charged to a request that merely
            # happened to be first, never repeated, and reported with
            # `qualname=None` because no in-root frame was open. An alarming
            # red chip with nothing actionable behind it.
            #
            # `_is_import` cannot catch that: it inspects the PATH being
            # opened, and a dotfile in the home directory looks like ordinary
            # application I/O. The give-away is the absent frame, not the path.
            #
            # Same rule as everywhere else here: report what can be attributed,
            # and stay quiet about what cannot.
            if self.monitor is not None:
                try:
                    if self.monitor.active_frame() is None:
                        return
                except Exception:
                    pass

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
        # Same thread as the monitor (the hook returns early off-loop, see the
        # loop_tid guard), so this read is safe either way — but it goes
        # through the same snapshot the watchdog uses, so there is one way to
        # ask "what is the loop running" and no unsafe pattern to copy.
        node = qual = None
        try:
            if self.monitor is not None:
                snap = self.monitor.active_frame()
                if snap is not None:
                    node, _trace, qual = snap
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
