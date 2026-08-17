# FastAPI Async Visualizer — Build Plan

A drop-in package for any existing FastAPI project that shows, **live and in real time**, how the app's async machinery actually works: **multiple concurrent requests**, the **single event loop** handing control between them, every **`await`** where a request suspends and resumes, and the **threadpool** (the 40-token limiter) filling up when sync work is offloaded — all animated in one browser dashboard as traffic flows.

This is a **development / exploration tool**, not production telemetry. You turn it on, throw concurrent requests at the app (or use the built-in load button), and *watch* the event loop work.

**Scope locked:** Python **3.12+** (enables real per-`await` tracing). One dashboard showing **lanes + event loop + threadpool** together.

Every mechanism below is verified against CPython, asyncio, AnyIO, and Starlette sources (see **Sources**).

---

## 1. The core idea, and why 3.12 makes it real

An async FastAPI app runs on **one event loop in one thread**. It looks concurrent because when a request hits an `await` that isn't ready, its coroutine **suspends** and the loop runs another request until *it* suspends, and so on. The whole "magic" is this interleaving of suspend/resume across requests on a single thread. Our job is to make that visible.

The hard part has always been seeing the `await` boundaries — the loop is a black box between task steps and older Python exposes no per-`await` hook. **Python 3.12's `sys.monitoring` (PEP 669) changes this.** It fires low-overhead events *exactly* at the moments we care about:

- **`PY_YIELD`** — a coroutine is about to **suspend at an `await`** (control returns to the loop).
- **`PY_RESUME`** — a coroutine **resumes** (the loop gave it control back).
- **`PY_START` / `PY_RETURN` / `PY_UNWIND`** — function enter / normal exit / exit via exception.

A `PY_YIELD` followed later by a `PY_RESUME` for the same task **is** "this request hit an await, released the loop, and later came back." Streaming these across all in-flight requests reconstructs the true interleaving — not a simulation, the real thing.

---

## 2. What each panel shows → the verified mechanism behind it

### Panel A — Request lanes (the awaits)
One horizontal lane per in-flight request. Along each lane: solid segments = **running on the loop**; gaps = **suspended at an `await`** (waiting on I/O, `asyncio.sleep`, a lock, etc.). Markers at each suspend/resume.

- **Mechanism:** `sys.monitoring` `PY_YIELD`/`PY_RESUME`/`PY_START`/`PY_RETURN`, filtered to the code objects we care about (the app's endpoints + optionally dependencies), attributed to the owning request. Timings from a monotonic clock.
- **Request identity:** a `loop.set_task_factory(...)` hook tags each request's Task at creation and we carry a trace id in a `contextvar` + on the Task, so every yield/resume maps to the right lane.

### Panel B — The event loop (who holds it, who's waiting)
A single "loop holder" indicator: at any instant, which request's coroutine is actually executing (only ever one, because single thread), plus the queue/set of ready-but-waiting tasks.

- **Mechanism:** `asyncio.current_task()` = who's running now; `asyncio.all_tasks()` = everyone alive on the loop. Combined with the yield/resume stream, we show control transfer as it happens.
- **Blocking detection (high-value, nearly free):** `loop.set_debug(True)` + a tuned `loop.slow_callback_duration` makes asyncio itself flag any callback that hogs the loop beyond the threshold — i.e. someone put blocking/CPU work inside an `async def` and froze *everyone*. The dashboard flashes the loop red and names the culprit. This is the single most instructive failure to be able to show.

### Panel C — The threadpool (40-token saturation)
A bank of worker-thread slots (default 40) that fill as `def` (sync) endpoints/dependencies are offloaded, with a queue for overflow.

- **Mechanism:** `def` handlers run via Starlette's `run_in_threadpool` → `anyio.to_thread.run_sync`, capped by AnyIO's default `CapacityLimiter` with `total_tokens = 40` (verified at source). We read `limiter.borrowed_tokens` / `limiter.total_tokens` live to render slots-in-use, and show requests **queued** once all 40 are taken.
- **The teaching moment:** fire 100 concurrent sync requests → 40 slots fill, 60 queue, throughput steps down. Fire 100 async-with-real-await requests → loop interleaves them, lanes stay busy, no thread saturation. Side by side, the difference is obvious.

All three panels share one clock and one trace-id space, so a request you see suspend in Panel A is the same one you see release the loop in Panel B.

---

## 3. How it attaches (no user code changes to routes)

```python
from fastapi import FastAPI
from async_viz import visualize

app = FastAPI()
# ... your routes ...

visualize(app)          # mounts dashboard at /_viz, installs the hooks
```

`visualize(app)` does four things, all verified-safe:
1. Installs a **`sys.monitoring`** tool id + event callbacks (3.12+), scoped to the app's code objects to keep overhead down.
2. Installs a **task factory** on the running loop to tag request-tasks (done at startup via a lifespan/startup hook, since the loop must exist).
3. Reads the **AnyIO threadpool limiter** each tick for Panel C.
4. Mounts a small **ASGI sub-app** at `/_viz` serving the dashboard SPA and a **WebSocket** that streams events to the browser.

Zero-code alternative via env (`ASYNC_VIZ=1 uvicorn app:app`) is feasible as a follow-up but not required for v1.

---

## 4. Architecture

```
             ┌────────────────────── your FastAPI app ──────────────────────┐
 requests →  │  event loop (1 thread)      AnyIO threadpool (≤40 tokens)     │
             │      ▲  sys.monitoring            ▲  limiter.borrowed_tokens   │
             │      │  PY_YIELD/RESUME/…         │                           │
             └──────┼────────────────────────────┼──────────────────────────┘
                    │                            │
              ┌─────┴───────── Collector ────────┴─────┐
              │  - normalizes events into span/edge log │
              │  - per-request lane state               │
              │  - ring buffer (bounded, dev-safe)      │
              └───────────────┬─────────────────────────┘
                              │  WebSocket (batched frames)
                    ┌─────────┴──────────┐
                    │  Dashboard SPA      │  Lanes + Loop + Threadpool
                    │  (mounted /_viz)    │  live, one shared timeline
                    └────────────────────┘
```

- **Event volume control:** `sys.monitoring` can be chatty. We scope to the app's own code objects (not the whole stdlib), coalesce events per loop-tick, and batch WebSocket frames (e.g. 30–60 fps) so the browser isn't flooded. Sampling (trace 1 in N requests) for heavy load.
- **Overhead honesty:** the tool measures and displays *its own* added latency so you can trust what you're seeing. Off = truly off (monitoring tool disabled, factory removed).

---

## 5. Tech stack

- **Package:** Python 3.12+, standard `pyproject.toml`, PyPI. Runtime deps: just `anyio` (already present) — asyncio and `sys.monitoring` are stdlib.
- **Instrumentation:** `sys.monitoring` (PEP 669), `asyncio` (`all_tasks`, `current_task`, `set_task_factory`, `set_debug`, `slow_callback_duration`), AnyIO limiter introspection.
- **Transport:** WebSocket via Starlette (already in FastAPI) — no extra server.
- **Dashboard:** single-page app served as a prebuilt bundle (no build step for the user). Rendering: Canvas or SVG for the lane/timeline animation; a light framework (or vanilla + a small timeline lib) is enough. Flame/waterfall-style lanes + a loop indicator + a pool grid.
- **Testing:** pytest + `httpx.ASGITransport` to fire real concurrent requests at a fixture app; assert the emitted event stream (task tagged, yields/resumes ordered, pool tokens move). CI matrix on 3.12 / 3.13 / 3.14.

---

## 6. Challenges & risks (honest)

- **Event volume / overhead.** Per-`await` monitoring across many requests generates lots of events. *Mitigation:* scope to app code objects, coalesce per tick, batch frames, sample under load, and always-visible self-overhead readout. This is why it's a dev tool, not prod.
- **Correct request attribution across the threadpool.** When a `def` handler is offloaded, work runs on a worker thread, not the loop. *Mitigation:* propagate the trace id explicitly across the `run_in_threadpool` boundary (not just via contextvars, which don't cross threads cleanly), so Panel C rows tie back to the right lane.
- **`sys.monitoring` is single-owner-ish per tool id.** Other profilers/debuggers also use it. *Mitigation:* register our own tool id, detect conflicts, degrade gracefully if another tool holds what we need, and document coexistence with debuggers.
- **`BaseHTTPMiddleware` contextvar caveat.** It can break contextvar propagation upward (verified). *Mitigation:* keep our own wrappers pure-ASGI, store identity on the Task/scope as fallback, and warn when a user middleware would disrupt propagation.
- **Version internals drift.** Task factory + AnyIO limiter shapes are stable but not a hard public contract. *Mitigation:* feature-detect, wrap introspection in try/except so a tracing failure never breaks a request (fail-soft), CI matrix.
- **"Concurrent, not parallel" must read correctly.** The loop panel must make it unmistakable that only one coroutine runs at a time, versus the threadpool where several threads genuinely run at once. *Mitigation:* deliberate visual distinction between the two panels.
- **Async-but-blocking is the key insight to surface, not hide.** The slow-callback flag is the mechanism; the UX should make a frozen loop dramatic and obvious.

---

## 7. Build order (milestones)

1. **Event backbone.** `sys.monitoring` callbacks + task factory + monotonic timing → a clean in-process event log (task started, yielded, resumed, returned), correctly attributed per request. Output as JSON first. *Proves the hard part works.*
2. **Threadpool reader.** Poll the AnyIO limiter; add sync-offload + queue events. *Now sync vs async is in the data.*
3. **Blocking detection.** Wire `set_debug` + `slow_callback_duration`; emit "loop blocked by X" events.
4. **WebSocket stream + Collector.** Bounded buffer, batched frames, trace-id space shared across all event sources.
5. **Dashboard v1 — all three panels** on one shared timeline: lanes (awaits), loop holder + waiters, pool grid. Live animation.
6. **Built-in load driver.** A "fire N concurrent requests" button (async vs sync presets) so the interleaving and the 40-token saturation are demoable without external tooling.
7. **Polish:** sampling, self-overhead readout, scoping controls, graceful degrade, docs.

**MVP to prove the concept:** milestones 1–2 + a rough version of 5 (lanes + pool), so you can *see* multiple real requests interleaving and the pool filling. Blocking detection (3) and the load driver (6) make it compelling right after.

---

## 8. Open questions (non-blocking — sensible defaults chosen, flag to change)

1. **Trace scope default:** app endpoints + dependencies only (quieter, recommended) vs. also user library `await`s (noisier, deeper). Default: endpoints + dependencies, with a toggle.
2. **Load driver in v1 or v2?** Default: v1 (milestone 6) — it makes the tool self-demonstrating. Say if you'd rather rely on external load (locust/httpx) first.
3. **Dashboard tech:** prebuilt Canvas-based SPA (smooth for many lanes) vs. SVG/React (easier to hack on). Default: Canvas for the animation, thin JS around it.
4. **Historical replay:** keep the last run to scrub through, or live-only for v1? Default: live-only, with a bounded buffer we can later expose as replay.

---

## Sources (verified)

- **PEP 669 / `sys.monitoring` (Python 3.12+ docs, CPython `Doc/library/sys.monitoring.rst`)** — `PY_START`, `PY_RESUME`, `PY_YIELD`, `PY_RETURN`, `PY_UNWIND` events; low-impact monitoring; per-tool-id registration; coroutine/generator resume & yield are the instrumented boundaries.
- **asyncio docs — Event loop / Developing with asyncio / Coroutines and tasks** — one loop per thread, only one task runs at a time, a task suspends at `await` and the loop runs the next; `current_task()`, `all_tasks()`, `set_task_factory()`, `eager_task_factory`; `set_debug(True)` + `slow_callback_duration` logs callbacks over threshold (default 100ms).
- **AnyIO docs + source (via Kludex/starlette #1724)** — default worker-thread `CapacityLimiter` `total_tokens = 40`, shared pool; `borrowed_tokens` readable; adjustable.
- **Starlette / FastAPI concurrency** — `async def` awaited on the loop vs `def` → `run_in_threadpool` → `anyio.to_thread.run_sync`; middleware is ASGI; `BaseHTTPMiddleware` breaks contextvar propagation upward (Starlette middleware docs).
- **Starlette applications source** — app is an ASGI callable; sub-apps/routes mountable (basis for serving the `/_viz` dashboard + WebSocket in-process).

*Version-sensitive internals (task-factory shape, limiter attributes) are feature-detected at runtime and CI-verified against the 3.12/3.13/3.14 matrix before being relied on.*
