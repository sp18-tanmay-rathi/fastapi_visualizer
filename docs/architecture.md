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
| `request_start` | `{method, path, request_id}` | a request began; branch root created for its trace_id. `request_id` = inbound `X-Request-ID`, or null |
| `request_end` | `{status, duration_ms, error?}` | the request finished; `status` is null if no response started, `error` is the exception class name if the app raised |
| `call_enter` | `{node_id, parent_id, qualname, file, line, is_async, execution}` | entered a function frame (a graph node); `execution` = `"event_loop"` or `"threadpool"` |
| `call_exit` | `{node_id}` | that frame returned or unwound |
| `suspend` | `{node_id, awaiting}` | frame hit an `await` and yielded the loop |
| `resume` | `{node_id}` | frame resumed on the loop |
| `offload_start` | `{node_id}` | a worker-thread (offloaded sync) call started |
| `offload_end` | `{node_id}` | that offloaded call returned |
| `pool_sample` | `{borrowed, total, queued}` | threadpool occupancy (emitted only on change) |
| `loop_blocked` | `{node_id, qualname, duration_ms}` | an in-root loop frame ran > `slow_ms` without yielding (stamped at the span START) |
| `loop_unblocked` | `{node_id, qualname, duration_ms}` | the blocking span ended (stamped at the span END) |
| `loop_stalled` | `{qualname, file, line, stack, elapsed_ms}` | the watchdog missed its heartbeat: the loop is unresponsive **right now**. `stack` is the captured loop-thread traceback |
| `loop_unstalled` | `{qualname, duration_ms}` | the loop started responding again |
| `blocking_call` | `{category, detail, node_id, qualname}` | the loop thread performed a forbidden wait (file / socket / DNS / database / subprocess), regardless of how long it took |

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

The timer alone is not enough, for two reasons. It is **retrospective** — the
span is reported once the frame ends, so a server that is hung right now shows
nothing. And it is **duration-based** — a 5ms `open()` on the loop thread is a
real bug that no threshold will ever catch, while a legitimate 200ms
computation trips it. Two more detectors close those gaps.

#### Watchdog (`watchdog.py`) — "is the loop stuck *right now*?"

A coroutine on the loop bumps a timestamp every 50ms. A **daemon thread**
(deliberately not on the loop — a stuck loop cannot report on itself) checks
that timestamp; when it has not moved for `stall_ms` (default 250, `stall_ms=0`
disables), the loop is not running callbacks, so it captures the loop thread's
frames with `sys._current_frames()` and emits `loop_stalled`. `_culprit()`
blames the **deepest in-root frame** in that stack, so a stall inside a library
is still attributed to the application function that called it. `loop_unstalled`
closes the span when the heartbeat resumes; `stop()` closes any span still open
at shutdown.

The watchdog is the only detector that sees a request which **never returns** —
the timer needs a `PY_RETURN` that will never arrive.

Its one structural limit: **it cannot reach the browser during the freeze.** The
WebSocket send runs on the loop that is stuck, so the event queues behind the
stall and arrives only once the loop recovers. It therefore also writes the
stall and its stack to the **log** from its own thread, immediately — which is
where you look when a server hangs.

#### Listener (`blockingcalls.py`) — "did the loop touch the outside world?"

`sys.addaudithook` receives an audit event for every file open, socket connect,
DNS lookup, DB connect and subprocess spawn in the process. If one fires while
the loop thread is inside a traced request, that is a blocking wait by
definition — **no threshold involved** — and a `blocking_call` is emitted with a
category (`file`, `network`, `dns`, `database`, `process`) and a short detail.

Four filters keep it quiet: its own package is skipped, worker threads are
skipped (blocking there is correct), calls outside an active trace are skipped,
and **imports** are skipped — `_is_import()` inspects the **full** path before
truncation, since a module load legitimately reads files. A bounded `_seen` set
(`_MAX_SEEN = 4096`) dedups repeats without growing without limit.

Its limit is **pooled connections**: Python announces that a connection was
*opened*, not that a query was *sent*. A real app opens once at startup and
reuses, so subsequent queries raise no event. It still catches files,
subprocesses, DNS and the first connect. It costs roughly 20% of throughput
(measured 3040 → 2683 req/s with tracing already on), because the interpreter
raises these events for every library in the process; `detect_blocking_calls=False`
turns it off.

#### Three verdicts, and what is deliberately *not* claimed

The frontend folds the three streams into three row tags: `⏱ STALLED` (frozen
right now), `🔥 blocking I/O: <category>` (a forbidden wait, from the listener),
and `⚙ held the loop <total> ×<n>` (from the timer). The last is **not** called
"CPU-bound": the absence of a detected wait is not evidence of computation.
`time.sleep` raises no audit event and leaves no Python frame, so labelling it
CPU would mislabel the single most common blocking call there is. The inspector
states the cause is unknown and lists the frames instead.

Timer spans accumulate into a per-request list rather than a max, so a request
that blocks twice reports the sum and both frames. A watchdog span and a timer
span covering the same stall are reconciled into one entry, not double-counted.

#### Static complement

Runtime detection only sees code that ran. `pyproject.toml` enables ruff's
`ASYNC` ruleset, which flags blocking calls inside `async def` at lint time —
including paths a test run never reaches. The two are complementary: ruff
catches the unexercised path, the runtime catches the dynamic call ruff cannot
see.

### Enable gate

`visualize()` resolves an `enabled` decision **before touching the app at all**
(`app.py:_resolve_enabled`): an explicit `enabled=` wins, else `FASTAPI_VIZ` in
the environment, else `app.debug`. When it resolves off, nothing is installed
and nothing is mounted — no middleware, no task factory, no `Monitor`, no
threadpool poller, no lifespan wrap, no `/_viz` route — so the call is safe to
leave in an app that ships to production. `app.state._viz` is set to
`{"enabled": False}` so the decision is introspectable, and one line is printed
explaining how to turn it on.

Deliberately absent: the old unconditional `loop.set_debug(True)`. It changed
the host app's behavior (slow-callback logging, coroutine origin tracking) and
cost overhead, and blocking detection does not need it — the monitor times wall
clock between `sys.monitoring` boundaries itself rather than reading asyncio's
slow-callback machinery.

Note the enable gate is about **not installing uninvited**, not about access
control: when enabled, the dashboard and its WebSocket are unauthenticated.

### Mount path

The dashboard mounts at `path` (default `/_viz`), normalized by
`_normalize_mount_path()` to a leading slash with no trailing one so
`"_viz"`, `"/_viz/"` and `"/debug/viz/"` all behave. A root mount raises
`ValueError` rather than silently shadowing the app's own routes — a config
mistake, not an instrumentation error, so fail-soft does not apply (same
reasoning as `Collector.subscribe()` raising without a running loop).

Nothing downstream is told the path: the page and the socket are siblings under
the mount, and `dashboard.js` derives its WebSocket URL from its own
`location.pathname` (`wsUrl()`). That keeps a configurable path compatible with
the no-build-step/offline constraint — no templating, no injected config.

### Identity

`identity.py` mints a trace id per request in a pure-ASGI `TraceMiddleware`
(not `BaseHTTPMiddleware`, which breaks contextvar propagation upward through
the stack), stamps it onto the request's `asyncio.Task` (`_viz_trace`) plus a
contextvar, and emits `request_start`/`request_end`. A wrapped task factory
(`install_task_factory`) copies `_viz_trace` onto any child task so nested
`asyncio.create_task()` calls stay attributed to the same request.
`current_trace()` reads the Task attribute first, falling back to the
contextvar.

Trace ids are `secrets.token_hex(8)` (16 hex chars) — wide enough not to collide
under real load. The dashboard displays a 6-char prefix on each row and keeps
the full id in the request inspector.

**Request outcome.** `TraceMiddleware` wraps the ASGI `send` callable and reads
`status` off the `http.response.start` message. It deliberately never touches
or buffers response bodies — status is all that's needed, and buffering would
change streaming behavior. The wrapper is also where `expose_request_id=True`
appends an `x-request-id` response header. `request_end` then carries `status`,
a `duration_ms` measured from middleware entry, and `error` (the exception class
name) when the application raised — the exception is re-raised, never swallowed.

**Request-id correlation.** An inbound `X-Request-ID` is always recorded on
`request_start` for correlation against upstream logs, but only replaces the
generated trace id when `correlate_request_id=True`; otherwise a client could
choose its own id. A correlated id is filtered to `[A-Za-z0-9._-]` and truncated
to 64 chars, since it is rendered in the UI and used as a map key.

### Threadpool

`threadpool.py` polls AnyIO's default thread `CapacityLimiter` (`borrowed`/
`total`/`queued`) every 50ms and pushes a `pool_sample` event only when the
tuple changes, so an idle app produces no event traffic. Per-request offload
attribution is emitted by `monitor.py`, not here: a request-root frame that
runs with **no current asyncio task** is executing on an AnyIO worker thread
(a sync `def` endpoint Starlette dispatched to the threadpool) — that frame's
`call_enter`/`call_exit` also fire `offload_start`/`offload_end`. This is
necessarily **best-effort** (see Known limitations).

The same rule applies **mid-request**: an `async def` endpoint that calls
`run_in_threadpool(...)` runs that callable with no current task, so it is
reported as offloaded too. Its `parent_id` used to come back `None` — the worker
thread has its own call stack, so the caller's frame was not on it, and the node
was stranded. `monitor.py` therefore carries a `_current_node` **ContextVar**;
anyio copies the calling context into the worker, so the offloaded frame reads
its true parent from there. That is what lets the dashboard draw the honest
picture: the **request parks on the loop** while a **worker runs the call**,
rather than the whole request appearing to migrate.

`_in_root()` also excludes library code that happens to live under a root — a
virtualenv inside the project directory is the common case. It rejects anything
under `sysconfig`'s library prefixes (`_LIB_PREFIXES`) or containing a
`site-packages` / `dist-packages` marker (`_LIB_MARKERS`) before applying the
root prefix test. Without it, one request in a real project produced 1241 nodes.

### Module map (`src/fastapi_visualizer/`)

| Module | Responsibility |
|---|---|
| `events.py` | `Event` dataclass + event-kind constants |
| `collector.py` | Bounded ring buffer + subscriber fan-out; singleton `collector` |
| `identity.py` | trace-id contextvar, pure-ASGI `TraceMiddleware`, task factory |
| `monitor.py` | `sys.monitoring` global-event registration, filename-scoped self-pruning, per-task/thread call stacks |
| `threadpool.py` | AnyIO `CapacityLimiter` poller → `pool_sample` events |
| `watchdog.py` | Loop heartbeat + off-loop detector thread → `loop_stalled` / `loop_unstalled` |
| `blockingcalls.py` | `sys.addaudithook` listener → `blocking_call` events |
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
- **A row never changes zone.** Its zone is decided once, by where the request
  *lives* — a sync endpoint belongs to the threadpool, an async one to the loop —
  and offloading work mid-request does not move it. An `async def` that calls
  `run_in_threadpool` stays in the loop zone, parked, while a separate entry for
  the offloaded frame appears in the threadpool zone. Moving the row instead
  would claim the request left the loop, which is false: its task is still there,
  waiting for the worker to finish.
- **Runtime state resolves in a deliberate order.** One trace can be offloading
  *and* running on the loop simultaneously — the task factory copies a parent's
  trace id onto its children, so `gather(run_in_threadpool(a), b())` gives one
  trace a worker-bound child and a loop-bound sibling. A **fresh** loop-holder
  claim therefore wins (`RUNNING`); a live offload beats a **stale** one
  (`WORKER` over `UNTRACED`), because "a worker is definitely busy" outranks "the
  loop last touched this trace a while ago".
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
- **Blocking (EVENT LOOP zone)**: three event streams, three durable row tags.
  `loop_stalled` puts the row in a `STALLED` runtime state while the freeze is
  live; `blocking_call` adds `🔥 blocking I/O: <category>`; `loop_blocked` /
  `loop_unblocked` accumulate into a `blockSpans` list rendered as
  `⚙ held the loop 1.01s ×2`. The tags persist through DONE, so a finished
  request still records that it froze the loop. Spans **accumulate** rather than
  keeping the maximum, and a watchdog span overlapping a timer span for the same
  freeze is reconciled into one entry instead of being counted twice. The
  offending node glows red for a short **real-time** window (clamped by the span
  length), independent of the playback clock, so it is visible in live and step
  mode alike. Per-frame detail — every span, its frame and its duration — lives
  in the inspector card rather than on the row, which stays terse.
- **Threadpool zone**: the whole zone means "on a worker thread", so the
  per-node "⇢ pool" stub is suppressed there; the worker-token grid
  (`borrowed/total`, filled cells) lives in the zone header.
- **Outcome tag** per row once finished: `200 · 42ms`, amber past the
  frontend-configurable slow threshold (`slow req`, default 500ms), red for a
  5xx or a raised exception. Derived from `request_end.extra`, with a fallback
  to the `request_end.t - request_start.t` delta if those fields are missing.
- **Request inspector**: clicking a row selects it and opens a DOM overlay
  (bottom-right) with full trace id, inbound request id, status, duration, zone,
  asyncio task count, call-node count, suspension count and blocking spans. DOM
  rather than canvas because the trace id must be selectable text; repainted on
  selection change and at most every 200ms while the request is live.
- **Row filter**: `path:` / `status:` / `slow:` / `zone:` terms plus bare
  substrings, ANDed. Applied where `render()` splits branches into the two zone
  lists — strictly display-only, it never affects row admission or recording.
- **Cross-request qualname highlight**: hovering a node outlines every frame of
  the same function in every other row. `hoverQual` is resolved from the
  *previous* frame's `hoverRects` (one frame of lag, imperceptible), which
  avoids a second layout pass.
- **Collapsed by default**: a row shows only its active call-path chain with a
  "[+N]" badge for the rest; clicking a row expands/collapses its full tree
  (the same click that selects it for the inspector).
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
- **The dashboard is unauthenticated when enabled.** The enable gate stops it
  installing uninvited; it is not access control. Anyone who can reach the port
  can read every path and the app's source structure. No token option yet.
- **Multi-worker is not aggregated.** `uvicorn --workers N` gives each process
  its own loop and its own in-memory collector, so the dashboard shows only the
  worker that served `/_viz`. Run a single worker.
- **Threadpool offload attribution is best-effort**: `sys.monitoring`
  callbacks fire on whichever OS thread runs the code, and
  `asyncio.current_task()` is `None` on a plain worker thread, so there is no
  per-task stack to key off of there. The thread-local stack fallback is only
  safe because AnyIO runs one offloaded call per worker thread at a time. The
  sync/async boundary of a single request *is* now bridged, but by the
  `_current_node` ContextVar rather than by the stack — so it holds only where
  the context is copied into the worker (anyio, asgiref). A pool that does not
  copy context gives the offloaded frame no parent.
- **Multi-worker processes each have their own in-memory collector.**
  `uvicorn --workers N` or gunicorn forks N separate processes; `/_viz` is
  served by whichever worker handles that request, and the ring buffer is
  per-process. Traffic handled by other workers is invisible. The dashboard
  surfaces this with a header banner when `WEB_CONCURRENCY` or
  `UVICORN_WORKERS` > 1 is detected. **Recommendation:** run a single worker
  (`uvicorn examples.demo:app`) during development.
- **The watchdog cannot reach the browser during a freeze.** The WebSocket send
  runs on the loop that is stuck, so `loop_stalled` queues behind the stall and
  arrives only once the loop recovers. It logs the stall and its stack from its
  own thread immediately as the workaround.
- **The blocking-call listener misses pooled queries.** Python's audit events
  announce a connection being *opened*, not a query being *sent*, so an app that
  opens once and reuses raises no event per query. Files, subprocesses, DNS and
  the first connect are still caught. The hook also costs ~20% of throughput
  (3040 → 2683 req/s with tracing already on) because the interpreter raises
  these events for the whole process; `detect_blocking_calls=False` disables it.
- **`⚙ held the loop` does not identify a cause.** The timer knows a frame ran
  long, not why. No audit event fired is not proof of computation — `time.sleep`
  raises none — so the verdict deliberately stops at "held the loop" and lists
  the frames instead of guessing "CPU-bound".

