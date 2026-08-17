"""Polls AnyIO's default thread CapacityLimiter to report pool saturation.

Per-request offload_start/offload_end attribution (a sync `def` endpoint's
work running on a threadpool worker) is emitted by monitor.py at call_enter/
call_exit of the request-root frame, not here — that's the only place with
node ids. It is necessarily best-effort: sys.monitoring callbacks fire in
whichever OS thread executes the code, and asyncio.current_task() is None in
a plain worker thread, so there is no per-task stack to key off of there.
monitor.py falls back to a thread-local stack, which is only safe because
anyio's threadpool runs one offloaded call at a time per worker thread — it
does not give a single, unified stack across the sync/async boundary of one
request.
"""

from __future__ import annotations

import asyncio
import time

import anyio.to_thread

from .collector import collector
from .events import Event, POOL_SAMPLE


async def poll_loop(stop_event: asyncio.Event, interval: float = 0.05) -> None:
    # Only emit when the pool state actually changes, so an idle app produces
    # no event traffic (the dashboard keeps the last sample) — the event
    # counter then reflects real activity instead of a constant heartbeat.
    last: tuple | None = None
    while not stop_event.is_set():
        try:
            limiter = anyio.to_thread.current_default_thread_limiter()
            borrowed = getattr(limiter, "borrowed_tokens", 0)
            total = getattr(limiter, "total_tokens", 0)
            try:
                queued = limiter.statistics().tasks_waiting
            except Exception:
                queued = 0
            queued = max(0, queued)
            state = (borrowed, total, queued)
            if state != last:
                last = state
                collector.push(
                    Event(
                        t=time.monotonic(),
                        kind=POOL_SAMPLE,
                        trace_id=None,
                        task_id=None,
                        name="threadpool",
                        extra={"borrowed": borrowed, "total": total, "queued": queued},
                    )
                )
        except Exception:
            pass
        await asyncio.sleep(interval)


def start(loop) -> tuple[asyncio.Task, asyncio.Event]:
    stop_event = asyncio.Event()
    task = loop.create_task(poll_loop(stop_event))
    return task, stop_event
