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

### Event kinds

| kind | extra fields | meaning |
|---|---|---|
| `request_start` | `{method, path}` | a request began; branch root created for its trace_id |
| `request_end` | `{}` | the request finished |
| `call_enter` | `{node_id, parent_id, qualname, file, line, is_async}` | entered a function frame (a graph node) |
| `call_exit` | `{node_id}` | that frame returned or unwound |
| `suspend` | `{node_id, awaiting}` | frame hit an `await` and yielded the loop |
| `resume` | `{node_id}` | frame resumed on the loop |
| `offload_start` | `{node_id}` | a sync request-root call started running on the threadpool |
| `offload_end` | `{node_id}` | that offloaded call returned |
| `pool_sample` | `{borrowed, total, queued}` | threadpool occupancy (emitted only on change) |

`Event` is `{t, kind, trace_id, task_id, name, extra}` (`events.py`), with
`to_dict()` for JSON. `node_id` is a global monotonically increasing int
assigned at `call_enter` and matched by `call_exit`.

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
attribution is emitted by `monitor.py`, not here: a sync (non-async) frame
with no parent on the stack is a request root running a plain `def`
endpoint, which Starlette dispatches to the threadpool — that frame's
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
into the **Collector**, a bounded ring buffer (`deque(maxlen=5000)`) that fans
each event out to subscriber queues. The `/_viz/ws` WebSocket handler
batches whatever is on its queue into a frame roughly every 33ms (~30fps) and
sends it to the browser; on connect it first sends a one-time backlog
snapshot of everything currently in the ring buffer.

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
{"events": [{"t": 0.0, "kind": "...", "trace_id": "...", "task_id": 0, "name": "...", "extra": {}}]}
```

`kind` is one of the nine values in the table above.

## Frontend: the flow graph

Single `<canvas>`, vanilla JS, no build step, no external dependencies —
works fully offline (`static/dashboard.js`).

- **Spine**: the event loop is drawn as a vertical bar ("EVENT LOOP (1
  thread)") on the left edge. Each displayed request is a **row** stacked
  down the spine; a row's call tree flows rightward from its root node
  (depth → x, sibling calls fan vertically within the row).
- **Loop holder**: derived client-side from the event stream, not measured
  directly — the single-loop rule is "the trace that most recently
  entered/resumed a frame and hasn't since suspended holds the loop." It is
  shown three ways: a bright, thick connector from that row to the spine, a
  glowing marker on the spine at that row's height, and a glow ring around
  the active node itself.
- **Suspended nodes** are dimmed, tagged with a ⏸ glyph, and connect to their
  parent with a faint dashed edge ("parked" — the loop moved on).
- **Offloaded nodes** (sync work on the threadpool) draw a short dashed "⇢
  pool" stub instead of parking. A **THREADPOOL** cluster box pinned
  bottom-right shows `borrowed/total` as a filled grid of cells.
- **Collapsed by default**: a row shows only its active call-path chain (root
  → the frame currently running/awaiting), with a "[+N]" badge summarizing
  everything else; click anywhere on a row to expand/collapse its full tree.
- **Variable-height rows**, stacked in arrival order (not a fixed slot per
  request), with vertical mouse-wheel scroll and a scrollbar when the stack
  overflows the viewport.
- **Slow-motion playback**: incoming events are buffered and replayed against
  a virtual clock advancing at `SPEED × real time` (header speed slider,
  0.05×–1.0×, default 0.2×) so millisecond-fast interleaving is watchable.
  The one-time backlog snapshot sent on connect is intentionally skipped —
  only live post-connect events animate.
- **Step mode**: the header "step" checkbox pauses the virtual clock; each
  "▶ step" click drains buffered events until the loop hands off to a
  different (non-null) holder — one control transfer per click.
- **Persistence**: finished requests stay on screen (greyed "done" node
  styling, root node tagged green "✓ finished") instead of fading out. A
  "clear" button wipes every displayed/hidden branch. "max req" (default 10,
  1–50) is the cap on rows *kept*; at the cap, the oldest **finished** row is
  evicted to admit a new live trace — if every kept row is still live, the
  new trace is hidden instead.
- **Tooltip** on node hover: qualname, `file:line`, and — while the node has
  an await recorded — "awaiting X" if still blocked or "await complete: X"
  once it has resumed or returned.
- **Header controls**: `load path` + `count` + `fire` (fires plain GETs,
  same-origin, no auth — a JWT-protected route needs an external driver),
  `speed` slider, `max req`, `step` toggle + `▶ step`, `clear`.

## Derived vs. measured

Every event in the WS frame (`call_enter`, `suspend`, `pool_sample`, …) is a
**measured** fact from `sys.monitoring` or the limiter poll. "Who holds the
loop" is not one of those events — it is **derived** client-side from the
measured stream by the single-loop rule above, which is exact as long as the
app has only one event loop thread (true for a standard FastAPI/uvicorn
process).

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
  between two measured events the loop-holder highlight is blind — it holds
  on the last known holder (or reads idle) until the next in-root event.
- The loop-holder highlight tracks **playback position** (the slow-motion
  virtual clock), not wall-clock time.
- **Threadpool offload attribution is best-effort**: `sys.monitoring`
  callbacks fire on whichever OS thread runs the code, and
  `asyncio.current_task()` is `None` on a plain worker thread, so there is no
  per-task stack to key off of there. The thread-local stack fallback is only
  safe because AnyIO runs one offloaded call per worker thread at a time — it
  does not unify the stack across the sync/async boundary of a single
  request.

