# Changelog

All notable changes to this project are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Blocking detection v2 — two more detectors alongside the timer.** The
  original threshold timer answers only "did a frame run long?", which is both
  retrospective (a server hung *right now* shows nothing) and duration-based (a
  5ms `open()` on the loop is a real bug no threshold catches). Two detectors
  close those gaps:
  - `watchdog.py` — a 50ms heartbeat on the loop plus an **off-loop daemon
    thread** that watches it. When the heartbeat misses `stall_ms` (default 250,
    `stall_ms=0` disables), the loop is captured with `sys._current_frames()` and
    a `loop_stalled` event is emitted, blaming the deepest in-root frame in the
    stack. This is the only detector that catches a request which **never
    returns**. It also writes the stall and its stack to the log immediately from
    its own thread, because the WebSocket send runs on the loop that is stuck.
  - `blockingcalls.py` — a `sys.addaudithook` listener that reports a
    `blocking_call` whenever the loop thread opens a file, connects a socket,
    resolves DNS, connects to a database, or spawns a process during a traced
    request. **No threshold**: a 1ms blocking read is reported. Own-package
    calls, imports, worker threads and untraced calls are filtered out, and the
    dedup set is bounded at 4096 entries. On by default;
    `detect_blocking_calls=False` turns it off (it costs ~20% throughput).
  - ruff's `ASYNC` ruleset is enabled as the static complement, catching blocking
    calls in `async def` on code paths a run never reaches.
- **Three honest verdicts on the row**: `⏱ STALLED` (frozen right now),
  `🔥 blocking I/O: <category>` (a forbidden wait at any speed), and
  `⚙ held the loop 1.01s ×2` (ran long, cause unknown). The last is deliberately
  *not* labelled "CPU-bound" — no audit event fired is not evidence of
  computation, and `time.sleep` raises none. Per-span detail lives in the
  inspector card so the row stays terse.
- **Demo endpoints for every case** in `examples/demo.py`: `/offloaded` (the
  correct way to call blocking code from async), `/fast_db` (listener-only — a
  1-2ms connect no timer could catch) and `/cpu` (pure computation, which draws
  the *same* row as `/blocking` — the demonstration that "held the loop" names a
  symptom, not a cause), alongside the existing `/async`, `/sync` and
  `/blocking`. One endpoint per distinct verdict, none duplicated; each docstring
  names the detector that should fire.

- **Multi-worker awareness** (Phase 3, plan task 9): when `WEB_CONCURRENCY`
  or `UVICORN_WORKERS` is > 1, the visualizer logs a startup warning and the
  dashboard shows a persistent header banner — "⚠ worker PID of multiple —
  showing only this worker's traffic · run single worker to see all". The
  in-memory `Collector` is per-process; each uvicorn/gunicorn worker only sees
  its own traffic. The banner makes this limitation explicit rather than silently
  showing incomplete data. New `meta` key in the first WebSocket frame carries
  `{worker_pid, multi_worker}` for the client to act on.
- **Configurable dashboard path** (Phase 5, plan task 11 — core arg):
  `visualize(app, path="/debug/viz")` moves the page, script and WebSocket
  together. Leading/trailing slashes are optional; `path="/"` raises
  `ValueError` instead of shadowing the app's own routes. `dashboard.js` now
  derives its socket URL from `location.pathname` rather than hardcoding
  `/_viz/ws`, so a custom mount needs no frontend change, no templating and no
  build step.
- **Opt-in enable gate** (Phase 3, plan task 7): `visualize(app, enabled=None)`.
  Default is auto — on when `FASTAPI_VIZ=1` is set or `app.debug` is true, off
  otherwise. When off, *nothing* is installed and nothing is mounted: no
  monitoring, no task factory, no threadpool poller, no middleware, no `/_viz`
  route. `app.state._viz` becomes `{"enabled": False}` and one line is printed
  explaining how to enable. This makes it safe to leave `visualize(app)` in an
  app that ships to production. Note the gate is about not installing
  uninvited, not access control — when enabled, `/_viz` is still
  unauthenticated (plan task 12, not done).
- **Request outcome: status code + duration** (Phase 5, plan task 14).
  `TraceMiddleware` wraps the ASGI `send` callable to read `status` off
  `http.response.start` — without touching or buffering response bodies — and
  stamps `request_end.extra` with `status`, `duration_ms`, and `error` (the
  exception class name) when the app raised. Application exceptions are
  re-raised, never swallowed. Each finished row shows `200 · 42ms`, amber past
  the new `slow req` threshold control (default 500ms), red for a 5xx or a
  raised exception.
- **Request inspector** (Phase 5, plan task 14): clicking a row opens a panel
  with the full trace id (selectable, for pasting into a log search), any
  inbound `X-Request-ID`, status, duration, execution zone, asyncio task count,
  call-node count, suspension count, and blocking spans. Implemented as a DOM
  overlay rather than canvas drawing so the ids are real selectable text.
- **Row filter** (Phase 5, plan task 14): header filter box taking
  space-separated ANDed terms — `path:/checkout`, `status:500`, `slow:true`,
  `zone:loop`/`zone:threadpool` — plus bare substrings matched against path and
  trace id. Display-only: it never changes what is recorded or which traces get
  a row.
- **Cross-request qualname highlight** (Phase 5, plan task 14): hovering a call
  node outlines that same function in every other row, showing where a shared
  helper is running across concurrent requests.
- **X-Request-ID correlation** (Phase 5, plan task 14): an inbound header is
  always recorded on `request_start` and shown in the inspector, and becomes the
  trace id only when `correlate_request_id=True` (filtered to `[A-Za-z0-9._-]`,
  truncated to 64 chars — a client must not be able to choose its own id
  unasked). `expose_request_id=True` sends the trace id back as an
  `x-request-id` response header; default off.
- **Blocking detection** (Phase 2, plan task 3): sync/CPU work inside a
  coroutine (`time.sleep`, a tight loop, a blocking driver call) freezes the
  single loop thread and stalls every other request — the classic async
  failure. `monitor.py` now measures wall-time per in-root loop frame between
  monitoring boundaries and, when a frame holds the loop longer than `slow_ms`
  (default 100, new `visualize(app, slow_ms=)` arg) without yielding, emits a
  `loop_blocked`/`loop_unblocked` span. The dashboard glows the offending node
  hot red and flashes the EVENT LOOP spine red with "🔥 BLOCKED by X (Ns)".
  Worker-thread work is never flagged (blocking there is expected). New
  `/blocking` demo endpoint exercises it.
- **Explicit runtime states** (Phase 1, plan task 4): each request row is
  tagged RUNNING / WAITING / UNTRACED / DONE instead of the dashboard inferring
  a single "loop holder" from the last event. UNTRACED shows when the loop
  holder has produced no in-root event for a moment — the loop is off in
  library code (stdlib / DB driver / HTTP client) the instrumentation can't
  see — so the spine marker dims to a hollow "loop: untraced" instead of a
  confident glow. Measured state is now visually distinct from inferred state.
- **Event sequence numbers + drop detection** (Phase 1, plan task 15): every
  `Event` now carries a process-wide monotonic `seq`, assigned authoritatively
  in `Collector.push()`. The dashboard tracks `seq` in receipt order and, when
  it sees a gap (the bounded server buffer shed events), surfaces a
  "⚠ N events dropped — some traces may be incomplete" banner instead of
  silently reconstructing an impossible tree.
- **Frontend replay tests** (a first slice of Phase 5, plan task 19):
  `tests/js/playback_test.js` loads the real `dashboard.js` under a stubbed DOM
  and drives it through a fake WebSocket and a fake `requestAnimationFrame`
  clock, asserting on the events that actually reach the graph. It does not need
  the task-18 module split to work. `tests/test_dashboard_playback.py` runs it
  from pytest and **skips** when node is absent, so node stays an optional tool
  rather than a new dev dependency.
- **Backend regression net** (Phase 1, plan task 1): `tests/test_monitor.py` +
  shared `tests/conftest.py` fixture cover async-generator vs sync-def
  classification, custom-lifespan install, fail-soft on monitoring
  unavailability, `roots` scoping (in/out), suspend↔resume pairing, child-task
  trace propagation, and monotonic `seq`.
- Initial uv project scaffold (fastapi, uvicorn, anyio; dev: pytest,
  pytest-asyncio, httpx).
- Docs: `architecture.md`, `plans/mvp.md`, `changelog.md`.
- MVP: `sys.monitoring` event backbone with per-request await tracing; AnyIO
  threadpool reader; Collector + WebSocket stream; canvas dashboard (lanes +
  pool grid) mounted at `/_viz`; demo app; backbone + threadpool tests.
- Dashboard load driver: fire N concurrent GETs at a path from the header bar
  (self-demonstrating, no external tooling); idle hint when no lanes.
- Slow-motion playback: header speed slider (0.05×–1.0×, default 0.2×). The
  dashboard buffers events and replays them on a time-dilated virtual clock so
  millisecond-fast request interleaving is watchable; idle gaps collapse,
  backlog is capped, connect starts near live.
- Vertical layout redesign: EVENT LOOP drawn as a vertical spine; each request
  is a row branching rightward (call depth → x, siblings fan vertically). Row
  count capped by a "max req" control (default 3) to keep it legible.
- Step mode: pause auto-playback and click "▶ step" to advance exactly one loop
  hand-off (suspend→resume to a different request) per click — makes the
  single-thread "one runs, others parked at await" model explicit.
- Backlog skip: the dashboard now ignores the on-connect snapshot and animates
  only live post-connect events (stale traces were hogging the row slots).
- Clarity at scale: each request collapses to its active call-path with a
  "[+N]" badge (click a row to expand/collapse its full tree); rows keep a
  fixed readable height and the canvas scrolls vertically when there are many.
  Defaults raised to 10 requests.
- Offload edge is now a short "⇢ pool" stub off the node instead of a
  full-canvas diagonal to the threadpool box.
- Finished requests persist (greyed, still expandable) instead of fading out;
  a "clear" button wipes the view. "max req" now means "max rows kept" — at the
  cap the oldest finished row is evicted to admit a new live one. Rows ordered
  by arrival.
- Finished request rows get a green "✓ finished" tag on the root node.
- Node hover tooltip shows qualname, `file:line`, and await state: "awaiting
  X" while a node is blocked on an await, "await complete: X" once it has
  resumed or returned.
- Each request gets a short random id (6 hex chars), shown as a `#id` tag above
  its row so concurrent requests are identifiable.
- Intern-friendly legend + one-line explainer pinned bottom-left of the
  dashboard (single-loop model + glyph meanings).

### Fixed

- **A freeze in untraced code no longer blames an innocent request.**
  `Monitor._loop_close` cleared only `_active_node`/`_active_since`, so
  `_active_trace` kept pointing at the last request that ran in-root code for
  the rest of the process. A stall in library or framework code inherited that
  trace — usually a request that had already finished — and the dashboard
  branded that row. Every field is now cleared together, and an unowned stall
  reports `trace_id: None` while still carrying the stack that identifies it.
- **Cross-thread reads of the monitor's frame state are now a single atomic
  snapshot.** `monitor.py` documents the `_active_*` fields as loop-thread-only
  and lock-free; the watchdog read two of them from its own thread, which could
  pair one frame's node with another's trace. `Monitor.active_frame()` returns
  one tuple, replaced by whole-object assignment.
- **The live "this frame is frozen right now" ring never once appeared.** The
  `loop_stalled` handler built its state object without copying `node_id`
  across, so `drawNode`'s `node.id === loopStalled.node_id` compared against
  `undefined` on every frame. The backend had been sending the id all along.
- **A live offload no longer masks a request executing on the loop** — see the
  entry under Changed.
- **`sys.addaudithook` is installed once per process instead of once per app.**
  Audit hooks cannot be removed, so every app startup leaked another permanent
  callback firing on every audited event. One dispatcher now fans out to a
  weak registry of live detectors.
- **Blocking recorded before a row is admitted keeps the same shape as after.**
  The pre-admission stash kept only the largest span and never populated
  `blockCount`/`blockSpans`, so a row admitted late could claim it held the
  loop while its inspector card listed no spans at all.
- **The two duplicated `offload_start` / `offload_end` handler pairs are merged**
  — they worked, but an edit to one would have missed the other.

- **Requests now appear automatically; auto-playback was completely stalled.**
  `render()` runs from page load, so `advancePlayback()` reached its idle branch
  long before any event existed — where `maxSeenT` is still `0` and `virtualT`
  is `null`. It set `virtualT = 0`, which made the clock non-null and
  permanently skipped the "begin near live" initialization below it. When a
  request finally arrived, the clock was ~500,000 server-seconds behind (server
  timestamps are `time.monotonic()`, i.e. seconds since boot), got clamped to
  `maxSeenT - MAX_LAG`, and then had to creep 20 server-seconds at the playback
  speed — 100 seconds of real time at the default 0.2x — before a single event
  rendered. The same flaw stalled every idle gap between bursts. Step mode
  appeared to be the only thing that worked because `doStep()` bypasses this
  clock entirely. The clock now jumps to the oldest buffered event whenever it
  is behind it, which collapses both the startup gap and every gap between
  bursts; `INIT_LOOKBACK` is gone (the on-connect backlog is already dropped
  outright, so it guarded nothing). Covered by `tests/js/playback_test.js`.
- **Offloaded sync requests no longer hang RUNNING forever in the live view.**
  `Collector.push()` fanned events out to subscriber `asyncio.Queue`s with a
  bare `put_nowait`. That is not thread-safe: a sync endpoint's
  `call_exit`/`offload_end` (and any offloaded-frame event) is pushed from an
  anyio **worker thread**, and a cross-thread `put_nowait` does not wake the
  loop parked in `await queue.get()`, so those completion events were stranded
  in the ring buffer and never streamed — the dashboard's threadpool rows sat
  at RUNNING and never reached DONE. Delivery is now scheduled on each
  subscriber's own loop via `call_soon_threadsafe`. (Loop-thread events, e.g.
  async requests, were unaffected, which is why only sync rows hung.)
- **Spurious "N events dropped" banner.** `Collector.push()` incremented the
  shared `seq` (a non-atomic read-modify-write) and scheduled fan-out from both
  the event loop and worker threads without synchronization, so two threads
  could grab the same seq or deliver out of seq order — which the client's
  gap detector read as dropped events. `push()`/`subscribe()`/`clear()` now
  hold a `threading.Lock`, so seq is unique/contiguous and deliveries are
  scheduled in seq order.
- **Over-cap requests never reappeared after a row finished.** A new trace
  arriving while all `max req` rows were still in-flight was added to a sticky
  hidden set and dropped forever — so an over-cap request in a simultaneous
  burst (e.g. the demo's `/blocking`, the 11th of 11) stayed invisible even
  after the others completed, and never flashed its blocking state. The hidden
  set is gone; such an event is dropped only for that instant and the trace is
  admitted (evicting the oldest finished row) as soon as a slot frees.
- **Step mode no longer appears stuck on threadpool traffic.** A step now
  advances until the loop hands off OR a request finishes; sync/threadpool work
  never touches the loop holder, so without the request-finish checkpoint a
  step drained the whole buffer at once and then looked frozen.
- **Ctrl+C no longer needs a second press.** The `/_viz/ws` handler was
  push-only and never read from the socket, so it could not see the
  `websocket.disconnect` uvicorn queues when it closes live connections
  (close 1012) during graceful shutdown. Uvicorn waits for each connection's
  ASGI task *before* sending the lifespan shutdown event, so with the
  dashboard open and the app idle the handler blocked on `queue.get()` forever
  and the server sat at "Waiting for background tasks to complete. (CTRL+C to
  force quit)". The handler now races a reader task against the event queue and
  exits on disconnect.
- **Async-generator dependencies no longer mislabeled as threadpool work**
  (Phase 1, plan task 6). `is_async` now tests `CO_COROUTINE | CO_ASYNC_GENERATOR`
  so an `async def ... yield` dependency (e.g. FastAPI's `get_db`) reads as
  async, and offload attribution switched from the guess
  `parent_id is None and not is_async` to the true signal — code running with
  no current asyncio task (an anyio worker thread). `call_enter` now carries an
  `execution: "event_loop" | "threadpool"` tag. Result: async generators stay
  on the loop; only genuine sync-def worker-thread work emits
  `offload_start`/`offload_end`.
- Instrumentation now installs by wrapping the app's `lifespan_context`
  instead of `add_event_handler("startup")`. Apps created with a custom
  `lifespan=` (which makes Starlette ignore startup handlers) previously showed
  only request start/end with no call tree; the monitor now installs in every
  configuration.

### Changed

- **Offloaded work is drawn truthfully: the request parks, a worker runs the
  call.** An `async def` that calls `run_in_threadpool` no longer migrates its
  whole row to the THREADPOOL zone — its task is still on the loop, waiting. The
  row stays in the EVENT LOOP zone, parked, and a separate entry for the
  offloaded frame appears in the threadpool zone. A row's zone is now decided
  once, by where the request lives, and never changes.
- **Offloaded frames get their real parent.** `monitor.py` carries a
  `_current_node` ContextVar; anyio copies the calling context into the worker
  thread, so an offloaded frame no longer reports `parent_id: None` and is no
  longer stranded in the graph.
- **Library code under a root is excluded from tracing.** A virtualenv inside
  the project directory used to be traced as application code — 1241 nodes for
  one request in a real project. `_in_root()` now rejects `sysconfig` library
  prefixes and any path containing `site-packages` / `dist-packages`.
- **A live offload no longer hides a request that is running on the loop.** The
  task factory copies a trace id onto child tasks, so one trace can have a
  worker-bound child and a loop-bound sibling at once;
  `gather(run_in_threadpool(a), b())` used to read "WAITING · worker" while the
  loop was demonstrably busy with that same request. A fresh loop-holder claim
  now wins, and a live offload beats only a stale one.
- **Blocking spans accumulate instead of overwriting.** A request that blocks
  twice reports the sum and both frames; a watchdog span and a timer span
  covering the same freeze are reconciled into one entry rather than
  double-counted.
- **Overlay panels share one right-side column.** The legend and the request
  inspector now live in a flex column pinned to the right edge — legend at the
  top, inspector at the bottom (it moved from bottom-left). Each shrinks into
  its own scroll rather than overlapping the other on a short window, and the
  column is `pointer-events: none` so the strip between them no longer swallows
  canvas clicks and wheel scrolling.
- **Legend rows lay out correctly.** Each row's description is now wrapped in a
  single element, so `<b>`/`<code>` inside it no longer become sibling
  flex/grid items competing for their own columns (the cause of the ragged
  alignment). Rows are a 2-column grid, so a glyph lines up with the FIRST line
  of a wrapped row instead of floating to its vertical middle; the loop-holder
  swatch is a real circle instead of an 18×12 ellipse.
- **`loop.set_debug(True)` is no longer set** (Phase 3, plan task 7). It changed
  the host app's behavior (slow-callback logging, coroutine origin tracking) and
  cost overhead for every visualized app. Blocking detection never needed it —
  `monitor.py` times wall clock between `sys.monitoring` boundaries itself.
- **Trace ids widened to 16 hex chars** (`secrets.token_hex(8)`, was
  `token_hex(3)`) so concurrent requests don't collide under real load. Rows
  display a 6-char prefix; the inspector shows the full id.
- **A row click now also selects the request** for the inspector, in addition to
  expanding/collapsing its call tree.
- **Two execution zones** (Phase 1, plan task 5): the dashboard now splits into
  a top EVENT LOOP zone (async requests, one-runs-at-a-time, holder glow) and a
  bottom THREADPOOL zone (sync/offloaded requests, several run in parallel),
  each with its own spine, header, row stack and scroll. Rows are classified
  from the backend's new `execution` tag on the request-root `call_enter`. Sync
  work can no longer be shown as the event-loop holder (it never sets
  `loopHolder`), and the worker-token grid moved from a pinned corner box into
  the threadpool zone header. The per-node "⇢ pool" stub is dropped inside the
  pool zone (the whole zone already means "on a worker thread").
- Threadpool poller emits `pool_sample` only on state change, so an idle app
  produces no event traffic (counter reflects real activity, not a heartbeat).
- **Visualization redesigned to a live flow-graph** (see
  `docs/plans/graph-redesign.md`): central EVENT LOOP hub with one branch per
  in-flight request = its full nested call tree. Node currently on the loop
  glows; suspended branches park at their `await`; sync work routes to a
  threadpool cluster. Backend event model reworked to a nested call tree
  (`request_start/end`, `call_enter/exit`, `suspend/resume`, `offload_start/end`)
  via global `sys.monitoring` scoped to project source by filename.
