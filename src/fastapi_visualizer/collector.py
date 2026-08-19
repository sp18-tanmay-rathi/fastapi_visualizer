"""In-process bounded event buffer with fan-out to WebSocket subscribers."""

from __future__ import annotations

import asyncio
import threading
from collections import deque

from .events import Event

BUFFER_MAXLEN = 5000
SUBSCRIBER_MAXLEN = 1000


class Collector:
    def __init__(self) -> None:
        self.buffer: deque[Event] = deque(maxlen=BUFFER_MAXLEN)
        # queue -> the event loop that owns it. Events are pushed from BOTH the
        # event-loop thread (middleware, async monitoring callbacks) AND anyio
        # worker threads (monitoring callbacks for offloaded sync frames), so
        # fan-out MUST be thread-safe. asyncio.Queue is not: put_nowait() from a
        # non-loop thread mutates the queue but does not wake the loop blocked
        # in `await queue.get()`, so worker-thread events (a sync endpoint's
        # call_exit/offload_end) would be stranded and its row would show
        # RUNNING forever. We schedule every delivery via call_soon_threadsafe
        # on the owning loop, which wakes the selector reliably from any thread.
        self._subscribers: dict[asyncio.Queue, asyncio.AbstractEventLoop] = {}
        self._seq = 0
        # push() runs on BOTH the event loop and anyio worker threads, so the
        # seq increment (a non-atomic read-modify-write) and the fan-out must be
        # serialized. Without this, two threads can grab the same seq or deliver
        # out of seq order, which the client reads as spurious "N events
        # dropped" gaps.
        self._lock = threading.Lock()

    @property
    def events(self) -> deque[Event]:
        return self.buffer

    def snapshot(self) -> list[Event]:
        return list(self.buffer)

    def push(self, event: Event) -> None:
        # Single authoritative ordering: every emitted event gets the next seq,
        # so a gap on the client side unambiguously means events were dropped
        # (by the bounded ring here or a full subscriber queue below).
        # Hold the lock across seq-assign + fan-out so seq is unique/contiguous
        # and deliveries are SCHEDULED in seq order (call_soon_threadsafe is
        # FIFO per loop, so the client then sees a contiguous seq stream).
        with self._lock:
            self._seq += 1
            event.seq = self._seq
            self.buffer.append(event)
            for q, loop in list(self._subscribers.items()):
                try:
                    loop.call_soon_threadsafe(self._deliver, q, event)
                except Exception:
                    # loop closed / shutting down — drop for that subscriber.
                    pass

    @staticmethod
    def _deliver(q: asyncio.Queue, event: Event) -> None:
        # Runs on the queue's own loop thread, so asyncio.Queue ops are safe.
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            try:
                q.get_nowait()  # drop oldest, keep the stream flowing
                q.put_nowait(event)
            except Exception:
                pass
        except Exception:
            pass

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=SUBSCRIBER_MAXLEN)
        try:
            loop = asyncio.get_running_loop()
        except Exception:
            # No running loop: the queue can't be registered for delivery, so
            # it would silently receive nothing. subscribe() is meant to be
            # called from the async WS handler; surface the misuse loudly
            # rather than handing back a dead queue.
            raise RuntimeError(
                "Collector.subscribe() requires a running event loop"
            ) from None
        with self._lock:
            self._subscribers[q] = loop
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers.pop(q, None)

    def clear(self) -> None:
        with self._lock:
            self.buffer.clear()
            self._subscribers.clear()
            self._seq = 0


collector = Collector()
