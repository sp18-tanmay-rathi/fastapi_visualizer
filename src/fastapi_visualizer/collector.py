"""In-process bounded event buffer with fan-out to WebSocket subscribers."""

from __future__ import annotations

import asyncio
from collections import deque

from .events import Event

BUFFER_MAXLEN = 5000
SUBSCRIBER_MAXLEN = 1000


class Collector:
    def __init__(self) -> None:
        self.buffer: deque[Event] = deque(maxlen=BUFFER_MAXLEN)
        self._subscribers: set[asyncio.Queue] = set()
        self._seq = 0

    @property
    def events(self) -> deque[Event]:
        return self.buffer

    def snapshot(self) -> list[Event]:
        return list(self.buffer)

    def push(self, event: Event) -> None:
        # Single authoritative ordering: every emitted event gets the next seq,
        # so a gap on the client side unambiguously means events were dropped
        # (by the bounded ring here or a full subscriber queue below).
        self._seq += 1
        event.seq = self._seq
        self.buffer.append(event)
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except Exception:
                    pass
            except Exception:
                pass

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=SUBSCRIBER_MAXLEN)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def clear(self) -> None:
        self.buffer.clear()
        self._subscribers.clear()
        self._seq = 0


collector = Collector()
