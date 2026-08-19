# Architecture

## Core idea

An async FastAPI app runs on **one event loop in one thread**. Concurrency is an
illusion built from interleaving: a request's coroutine runs until it hits an
`await` that isn't ready, **suspends** (yields control back to the loop), and
the loop runs a different request until *it* suspends — repeat. There is never
more than one coroutine executing at once. Sync `def` endpoints are the
exception: Starlette offloads them to an AnyIO threadpool worker thread, where
they run genuinely in parallel with the loop.

Seeing this has historically required guesswork, because the loop is a black
box between task steps. **Python 3.12's `sys.monitoring` (PEP 669)** removes
the guesswork: it fires real events at function call/return/yield/resume
boundaries, cheaply enough to run alongside real traffic.

## Backend event model

Monitoring is installed **globally** (not per-function) for `PY_START`,
`PY_RETURN`, `PY_UNWIND`, `PY_YIELD`, `PY_RESUME`. Every callback first checks
`code.co_filename` against the configured project roots:

- **Not under a root** (stdlib, site-packages, or the visualizer's own
  package) → the callback returns `sys.monitoring.DISABLE`, which permanently
  stops the interpreter from calling back for that `(tool, code, event)`
  location. This is what keeps the overhead low — code outside the app is
  instrumented once, then never again. (`PY_UNWIND` can't be disabled this
  way — CPython raises if you try — so that callback just no-ops on
  out-of-root code instead.)
- **Under a root, no active request** (`identity.current_trace()` is `None`)
  → callback returns `None` (stays enabled, emits nothing).
- **Under a root, inside a request** → a call-tree event is recorded.

Each active `asyncio` Task keeps its own call stack (`task._viz_stack`, a list
of node ids) plus a process-wide monotonic node-id counter. `PY_START` pushes
a new node id (parent = the stack's current top, or `None` at the request
root) and emits `call_enter`; `PY_RETURN`/`PY_UNWIND` pop and emit
`call_exit`; `PY_YIELD` emits `suspend` for the top-of-stack node; `PY_RESUME`
emits `resume`. When code runs off the event loop (offloaded to the
threadpool), `asyncio.current_task()` is `None`, so the same bookkeeping falls
back to a thread-local stack — correct only because AnyIO runs one offloaded
call per worker thread at a time.

**Async vs. offloaded classification.** `call_enter` carries two derived
fields the frontend keys its two zones off of:

- `is_async` tests `CO_COROUTINE | CO_ASYNC_GENERATOR` on the code object, so
  both `async def` **and** `async def … yield` (async-generator dependencies
  like FastAPI's `get_db`) count as async. Testing `CO_COROUTINE` alone — the
  earlier bug — wrongly read async generators as sync.
- `execution` is `"threadpool"` when the frame runs with **no current asyncio
  task** (an AnyIO worker thread — the real offload signal), else
  `"event_loop"`. Only a worker-thread request root emits
  `offload_start`/`offload_end`. This replaced an earlier heuristic
  (`parent_id is None and not is_async`) that misfired on loop-run async
  generators.

### Event kinds

| kind | extra fields | meaning |
|---|---|---|
| `request_start` | `{method, path}` | a request began; branch root created for its trace_id |
| `request_end` | `{}` | the request finished |
| `call_enter` | `{node_id, parent_id, qualname, file, line, is_async, execution}` | entered a function frame (a graph node); `execution` = `"event_loop"` or `"threadpool"` |
| `call_exit` | `{node_id}` | that frame returned or unwound |
| `suspend` | `{node_id, awaiting}` | frame hit an `await` and yielded the loop |
| `resume` | `{node_id}` | frame resumed on the loop |
| `offload_start` | `{node_id}` | a worker-thread (offloaded sync) call started |
| `offload_end` | `{node_id}` | that offloaded call returned |
| `pool_sample` | `{borrowed, total, queued}` | threadpool occupancy (emitted only on change) |
| `loop_blocked` | `{node_id, qualname, duration_ms}` | an in-root loop frame ran > `slow_ms` without yielding (stamped at the span START) |
| `loop_unblocked` | `{node_id, qualname, duration_ms}` | the blocking span ended (stamped at the span END) |

`Event` is `{seq, t, kind, trace_id, task_id, name, extra}` (`events.py`), with
`to_dict()` for JSON. `node_id` is a global monotonically increasing int
assigned at `call_enter` and matched by `call_exit`. `seq` is a process-wide
monotonic counter assigned authoritatively in `Collector.push()` — the client
detects dropped events by watching for gaps in it (see Data flow).

### Blocking detection

The classic async failure is sync/CPU work inside a coroutine (`time.sleep`, a
tight loop, a blocking driver call) — it freezes the single loop thread, so
*every* other request stalls until it finishes. There is **no monitoring event
during** such a stall: the monitor sees `PY_START` … (300ms of nothing) …
`PY_RETURN`. So blocking is measured **retrospectively, per interval between
boundaries**, not as a "start → blocked → resume" state.

`monitor.py` tracks which in-root frame is executing **on the event-loop
thread** and since when (`_active_node`/`_active_since`, updated at every
`PY_START`/`PY_RESUME`/`PY_YIELD`/`PY_RETURN`). At each boundary it closes the
open interval: if the frame held the loop longer than `slow_ms` (default 100,
via `visualize(app, slow_ms=)`) without yielding, that interval was a blocking
span, and a `loop_blocked` (stamped at the span start) + `loop_unblocked`
(stamped at the span end) pair is emitted. Stamping the pair at the real span
boundaries lets the slow-motion frontend hold the node red for the dilated
block duration.

Only **loop-thread** frames are tracked (`asyncio.current_task()` is not
`None`); worker-thread work is never flagged, because blocking on a worker is
expected — that's the point of the threadpool. Because it's a single thread,
the interval fields need no lock. Yielding (`PY_YIELD`) closes the interval and
leaves nothing attributed, so the await/scheduling wait is never counted as
blocking; a long run *before* an await still is.

### Identity

`identity.py` mints a trace id per request in a pure-ASGI `TraceMiddleware`
(not `BaseHTTPMiddleware`, which breaks contextvar propagation upward through
the stack), stamps it onto the request's `asyncio.Task` (`_viz_trace`) plus a
contextvar, and emits `request_start`/`request_end`. A wrapped task factory
(`install_task_factory`) copies `_viz_trace` onto any child task so nested
`asyncio.create_task()` calls stay attributed to the same request.
`current_trace()` reads the Task attribute first, falling back to the
contextvar.

### Threadpool

`threadpool.py` polls AnyIO's default thread `CapacityLimiter` (`borrowed`/
`total`/`queued`) every 50ms and pushes a `pool_sample` event only when the
tuple changes, so an idle app produces no event traffic. Per-request offload
attribution is emitted by `monitor.py`, not here: a request-root frame that
runs with **no current asyncio task** is executing on an AnyIO worker thread
(a sync `def` endpoint Starlette dispatched to the threadpool) — that frame's
`call_enter`/`call_exit` also fire `offload_start`/`offload_end`. This is
necessarily **best-effort** (see Known limitations).

### Module map (`src/fastapi_visualizer/`)

| Module | Responsibility |
|---|---|
| `events.py` | `Event` dataclass + event-kind constants |
| `collector.py` | Bounded ring buffer + subscriber fan-out; singleton `collector` |
| `identity.py` | trace-id contextvar, pure-ASGI `TraceMiddleware`, task factory |
| `monitor.py` | `sys.monitoring` global-event registration, filename-scoped self-pruning, per-task/thread call stacks |
| `threadpool.py` | AnyIO `CapacityLimiter` poller → `pool_sample` events |
| `app.py` | `visualize()` — wires everything, mounts `/_viz`, serves the WebSocket |
| `static/` | `index.html` + `dashboard.js` — the prebuilt canvas SPA |

## Data flow

Instrumentation (monitoring callbacks + limiter poll) pushes `Event` objects
into the **Collector**, a bounded ring buffer (`deque(maxlen=5000)`) that
stamps each event with a monotonic `seq` and fans it out to subscriber queues
(each bounded; oldest dropped on overflow). Events are pushed from **two kinds
of thread** — the event loop (middleware, async callbacks) and anyio worker
threads (callbacks for offloaded sync frames) — and `asyncio.Queue` is not
thread-safe, so each delivery is scheduled on the subscriber's own loop via
`loop.call_soon_threadsafe`. A plain `put_nowait` from a worker thread does not
wake the loop blocked in `await queue.get()`, which would strand a sync
endpoint's `call_exit`/`offload_end` and leave its row RUNNING forever. The `/_viz/ws` WebSocket handler
batches whatever is on its queue into a frame roughly every 33ms (~30fps) and
sends it to the browser; on connect it first sends a one-time backlog
snapshot of everything currently in the ring buffer. Because the buffers are
bounded, a busy app can shed events — the client watches `seq` for gaps and
surfaces a "N events dropped" banner rather than silently reconstructing an
impossible tree.

```
        ┌──────────────────────── your FastAPI app ─────────────────────────┐
reqs →  │  event loop (1 thread)          AnyIO threadpool (≤40 tokens)      │
        │      ▲ sys.monitoring                ▲ limiter.borrowed_tokens     │
        │      │ call_enter/exit/suspend/resume │                           │
        └──────┼───────────────────────────────┼───────────────────────────┘
               │                               │
         ┌─────┴────────────── Collector ──────┴─────┐
         │  ring buffer (bounded) + subscriber fan-out │
         └───────────────────┬──────────────────────--┘
                              │ WebSocket, batched frames (~30fps)
                    ┌─────────┴──────────┐
                    │ /_viz dashboard SPA │  canvas flow-graph, vanilla JS
                    └─────────────────────┘
```

### WS frame contract

```json
{"events": [{"seq": 1, "t": 0.0, "kind": "...", "trace_id": "...", "task_id": 0, "name": "...", "extra": {}}]}
```

`kind` is one of the eleven values in the table above.

## Frontend: the flow graph

Single `<canvas>`, vanilla JS, no build step, no external dependencies —
works fully offline (`static/dashboard.js`). It is **view-only**: it never
issues requests to the app; traffic is driven externally (curl, httpx,
`examples/drive.py`, real users).

- **Two zones.** The canvas splits into a top **EVENT LOOP** zone (async
  requests — root frame `execution == "event_loop"`) and a bottom
  **THREADPOOL** zone (sync/offloaded requests — `execution == "threadpool"`).
  Each zone has its own vertical spine, header, row stack, and scroll; the
  divider sits proportionally to each zone's row count. This teaches the real
  distinction: on the loop only one request runs at a time, on the threadpool
  several worker threads run genuinely in parallel. A branch defaults to the
  loop zone until its request-root `call_enter` classifies it.
- **Rows.** Each displayed request is a row; its call tree flows rightward
  from the root node (depth → x, siblings fan vertically within the row).
- **Runtime state** (per row, shown as a tag next to the `#id`): `RUNNING`
  (executing now), `WAITING` (parked at an `await`), `UNTRACED` (loop holder
  is off in code outside the roots — see below), `DONE` (finished).
- **Loop holder** (EVENT LOOP zone only): derived client-side, not a measured
  event — "the async trace that most recently entered/resumed a frame and
  hasn't since suspended." Shown as a bright thick connector to the spine, a
  glowing spine marker, and a glow ring on the active node. **Threadpool rows
  never set or steal the holder** — sync work isn't on the loop. When the
  holder has produced no in-root event for a short interval (playback time),
  its state flips to `UNTRACED` and the spine marker dims to a hollow "loop:
  untraced" instead of a confident glow.
- **Suspended nodes** are dimmed, tagged ⏸, and connect to their parent with a
  faint dashed edge ("parked").
- **Blocking (EVENT LOOP zone)**: detection is retrospective — no event fires
  while the loop is frozen, so `loop_blocked` (span start) and `loop_unblocked`
  (span end) only arrive together at the end. On `loop_blocked` the loop spine
  overpaints red with "🔥 BLOCKED by `<qualname>` (Ns)" and the node glows red
  for a short **real-time** window (clamped by the span length), independent of
  the playback clock so it's visible in both live and step mode. The affected
  request also gets a **durable** "🔥 blocked" tag next to its runtime state
  that persists through DONE, so a finished request still records that it froze
  the loop. This surfaces sync/CPU work stalling every other request.
- **Threadpool zone**: the whole zone means "on a worker thread", so the
  per-node "⇢ pool" stub is suppressed there; the worker-token grid
  (`borrowed/total`, filled cells) lives in the zone header.
- **Collapsed by default**: a row shows only its active call-path chain with a
  "[+N]" badge for the rest; click a row to expand/collapse its full tree.
- **Variable-height rows**, stacked in arrival order, with per-zone
  mouse-wheel scroll and a scrollbar when a zone's stack overflows its band.
- **Slow-motion playback**: incoming events are buffered and replayed against
  a virtual clock advancing at `SPEED × real time` (header speed slider,
  0.05×–1.0×, default 0.2×). The one-time backlog snapshot on connect is
  skipped — only live post-connect events animate.
- **Step mode**: the "step" checkbox pauses the virtual clock; each "▶ step"
  click drains buffered events until the loop hands off to a different holder.
- **Persistence**: finished requests stay (greyed "done" styling, root tagged
  green "✓ finished") instead of fading. "clear" wipes everything. "max req"
  (default 10, 1–50) caps rows *kept*; at the cap the oldest **finished** row
  is evicted, else a new trace is hidden.
- **Dropped-event banner**: if the stream's `seq` skips (server shed events
  under load), the header shows "⚠ N events dropped — some traces may be
  incomplete".
- **Tooltip** on node hover: qualname, `file:line`, and await state ("awaiting
  X" / "await complete: X").
- **Header controls**: `speed` slider, `max req`, `step` toggle + `▶ step`,
  `clear`. (No load/fire control — the dashboard is view-only.)

## Derived vs. measured

Every event in the WS frame (`call_enter`, `suspend`, `pool_sample`, …) is a
**measured** fact from `sys.monitoring` or the limiter poll. "Who holds the
loop" is not one of those events — it is **derived** client-side by the
single-loop rule above, exact as long as the app has one event-loop thread
(true for a standard FastAPI/uvicorn process). Crucially the UI now marks the
gap in that derivation: between two measured in-root events the loop may be in
untraced library code, so a stalled holder is shown as `UNTRACED` rather than
implying its last frame is still executing.

## Fail-soft

Every instrumentation path — monitoring callbacks, limiter reads, the task
factory, `TraceMiddleware`, collector fan-out — is wrapped so a tracing error
**never** breaks a request. This is a dev tool riding alongside real traffic;
it must degrade silently, not take the app down. `install()`/`uninstall()`
acquire and free the `sys.monitoring` tool id cleanly so uninstalling truly
disables tracing (no leaked callbacks or DISABLE state).

## Known limitations

- **Only the app's own source is traced** (`roots`, default: the directory of
  the module that called `visualize()`). Time spent inside stdlib,
  site-packages, or the event loop's own internals produces no events, so
  between two measured events the loop-holder derivation is blind. This is now
  **surfaced rather than hidden**: a holder that goes quiet flips to the
  `UNTRACED` state instead of implying it's still running.
- **Bounded buffers can drop events under load** (ring 5000, per-subscriber
  queue 1000). Dropping is no longer silent — `seq` gaps drive a client
  banner — but a trace spanning a drop may still render incompletely.
- The loop-holder highlight tracks **playback position** (the slow-motion
  virtual clock), not wall-clock time.
- **Threadpool offload attribution is best-effort**: `sys.monitoring`
  callbacks fire on whichever OS thread runs the code, and
  `asyncio.current_task()` is `None` on a plain worker thread, so there is no
  per-task stack to key off of there. The thread-local stack fallback is only
  safe because AnyIO runs one offloaded call per worker thread at a time — it
  does not unify the stack across the sync/async boundary of a single
  request.

