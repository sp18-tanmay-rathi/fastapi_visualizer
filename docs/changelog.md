# Changelog

All notable changes to this project are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Dashboard redesign — "Instrument".** A node's state now rides a 4px left
  stripe instead of flooding the body with a saturated hue under white text,
  which was the actual cause of the old illegibility. Contrast for the three
  greys the palette leaned on went from 2.26:1 / 4.02:1 / 6.38:1 to
  5.9:1 / 5.5:1 / 9.4:1, and every type size rose 1–2px. All tokens live in
  `static/viz/theme.js`.
- **The canvas is DPR-scaled.** The backing store is sized to
  `devicePixelRatio` (capped at 2) with the context pre-multiplied, so layout
  maths stays in CSS px. Text on retina displays was previously upscaled by the
  browser, which no colour change could have fixed.
- **Connectors point.** Edges run border-to-border with an arrowhead instead of
  centre-to-centre with both ends hidden under the boxes.
- **The zone divider can be dragged**, with a grip and a `ns-resize` cursor;
  double-click returns it to the automatic proportion.
- **Row tags are chips** on a tinted ground rather than bare glyphs, so a 10px
  icon is findable on a near-black canvas and reads with its label.
- **A zone's minimum size is now in pixels, not a fraction.** 26% of a laptop
  screen came out shorter than a zone's own header, so its first row drew on
  top of the header text; and `spineBottom` was forced to a minimum that
  deliberately overflowed the band. Each zone now keeps its header plus one
  collapsed row, and rows never draw outside their band.
- **Depth spacing widened 150px → 184px.** Against a 140px node the old gap was
  10px and an arrowhead is 7 of them, so connected boxes read as touching.
- **The "✓ finished" caption under a request root is gone** — the row header
  already carries a ✓ DONE chip and the outcome, so it repeated itself and
  collided with the tree drawn beneath it.
- **The pinned-divider hint moved above the line and only shows on hover.** On
  the line, the divider struck through it.
- **Per-call timing on expanded rows.** Every ingredient was already in the
  stream (`call_enter` / `call_exit` / `suspend` / `resume` all carry `ev.t`),
  so this costs nothing on the wire. Three forms, each saying only what can be
  proved: `80ms on loop`, `202ms · 0ms on loop` (took 202ms, parked for all of
  it, cost nobody), `205ms on worker`.

  A frame **with children** deliberately shows elapsed only. `sys.monitoring`
  emits suspend/resume for the frame that actually yields and never for its
  callers, so a parent has no record of the time its children spent parked;
  `elapsed - awaitMs` applied to one counts that as loop occupancy. Measured on
  a real capture: an endpoint that held the loop for 80ms was reported as
  holding it for 282. Sibling spacing widened 40px → 58px to fit the line.
- **The durable `⇢ pool` chip no longer appears on THREADPOOL rows.** That row
  already *is* a worker, so the chip restated the row's own zone and put a
  second, smaller number beside the request total, reading as a contradiction
  rather than a breakdown. The per-node `⇢ pool` stub was already suppressed
  in that zone; this chip was the marker that had been missed. The
  total-versus-worker split moved to the Request card, where it can be named:
  `on a worker 410ms` and `not on a worker 308ms`, the latter explicitly not
  attributed to a cause (queueing, framework overhead and a loop frozen by
  someone else are indistinguishable here).
- **The row cap defaults to 20 instead of 10.** Ten is below the concurrency
  people actually drive at the tool, so the cap was being hit in ordinary use.
  The fallback used when the box is cleared moved with it — left at 10 it would
  have snapped the cap back to the old default silently. Still adjustable in
  the header (1–50) and deliberately *not* also a `visualize()` argument: two
  ways to set one value only invites them disagreeing.
- **A row is complete or absent — never partly invented.** Only
  `request_start` can create one now; `call_enter` used to as well, which is
  how a request refused at the row cap still turned up later, built by
  whichever event arrived once a slot freed. That row was wrong twice over: it
  appeared to **start late**, so fifty simultaneous requests rendered as a
  staggered trickle — the exact opposite of what this tool exists to show —
  and every `call_enter` that arrived while it was refused had been dropped, so
  its tree was missing frames and the request looked like it did less work than
  it did. Measured: 50 concurrent requests at a 10-row cap produced forty such
  rows, each drawing `? ?` because `method`/`path` ride only on
  `request_start`.

  Withheld requests are now counted in the alert strip —
  `⚠ 12 requests not shown — raise rows to see them` — so the cap can never
  distort the concurrency picture silently.

  Two consequences worth stating. Requests already in flight when the dashboard
  connects no longer appear at all, since their `request_start` predates the
  connection and the collector does not replay (open the page first, as the
  README says). And a `request_start` lost to event shedding takes its whole
  row with it rather than leaving a partial one — the `seq`-gap drop warning
  already covers that case.
- **The busy count can no longer be sampled away.** `threadpool.py` polls the
  limiter from a task *on the event loop* and pushes a sample only when the
  numbers change, so the header could read `0/40 busy` with rows visibly
  running — and step mode freezes that window on screen indefinitely. The
  header now shows `max(sampled, observed)`, where observed is the live
  offload count derived from `offload_start`/`offload_end`, which cannot be
  sampled away. Each source can only under-report (the sampler misses windows;
  the observed count misses rows evicted by the cap), so the larger is right in
  both directions and neither can invent a busy worker. Measured: 50 concurrent
  requests produced **three** samples for the whole run.
- **The threadpool header reports live and shown**, matching the loop zone's
  `0 live · 8 shown`. Without it, a zone full of finished rows next to
  `0/40 busy` read as a contradiction rather than as "these are all done".
- **The threadpool header reports calls queued for a free thread.** The limiter
  has always sent `queued` on every `pool_sample` and nothing ever displayed
  it. It is the one place the tool can honestly say "waiting *for* a worker" —
  a row can only ever say a worker is already running its call, because the
  limiter knows how many calls are waiting but not which request each belongs
  to.
- **`WAITING · worker` says what it means.** The old wording read as "waiting
  for a worker to become free", which is a different state; it means a worker
  already *has* the work while the coroutine is parked.
- **The empty state is a card inside the EVENT LOOP band.** Centred on the
  whole canvas it landed on the divider — the line struck through the sentence
  and the drag grip sat on top of one of its words. It now centres in the band
  where rows would actually appear, and in the graph area rather than under the
  side panel, whose width it reads from the element instead of duplicating.
- **The guide explains the loop-holder spine dot again.** It had been trimmed
  as redundant with the RUNNING chip, which was wrong — the chip is a row's
  state, the dot is where to look on the spine, and it is the single most
  important thing on the screen.
- **The header is grouped** into playback / show / filter / clear with
  micro-labels, and the dropped-event and multi-worker warnings moved to their
  own strip. They used to sit inside the header's flex row, so raising one
  shifted every control sideways. `max req` and `slow req` are now `rows` and
  `slow over`, which say what they are.
- **One side panel with two tabs** replaces the stacked legend and inspector,
  which had been competing for the same column and so both had to scroll.
  *What am I looking at?* is the default — the request pane is empty until you
  click something, so leading with it greeted a first run with nothing.
  Clicking a row always brings *Request* forward; deselecting returns the guide.
- **Keyboard**: `Space` steps while step mode is on (ignored when a field has
  focus, so a space in a filter term is still a space) and `/` focuses the
  filter. Visible `:focus-visible` rings throughout, and the canvas is
  focusable. There were previously zero keyboard handlers and zero ARIA
  attributes.
- **The frontend is split.** `static/viz/theme.js`, `geometry.js`,
  `primitives.js` and `filter.js` hold the genuinely pure parts; the coupled
  core (state, ingest, playback, render) stays in `dashboard.js`, because
  sharing reassignable state across files would mean moving every read and
  write onto a state object. Plain ordered `<script>` tags, no build step. The
  order is mirrored in `tests/js/_sources.js` so a mismatch fails a test rather
  than blanking the dashboard.
- **One static route replaces a hardcoded route per file**, with two
  independent guards: a name pattern that cannot express `..`, and a
  `resolve()` containment check. Both matter — without them Starlette
  normalises plain `../app.py` away, but `..%2Fapp.py` reaches the handler and
  discloses source. Refusals are indistinguishable from genuine misses.

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

- **The audit-hook dispatcher can no longer raise into application code.**
  `_dispatch` built its snapshot with `tuple(_ACTIVE)`, which races with the
  `add()`/`discard()` calls in `install()`/`uninstall()` on another thread and
  raises `RuntimeError: Set changed size during iteration` — measured 56 times
  in two seconds under a tight add/discard loop. That `tuple()` sat *outside*
  the `try`, and because this is the process-wide `sys.addaudithook` callback,
  the exception surfaces **inside whatever audited call triggered it**: a plain
  `open()` in application code, on whatever thread ran it. Confirmed directly —
  a hook that raises makes an unrelated `open()` fail with the hook's own
  exception. Realistic in exactly the multi-app case the `WeakSet` exists for:
  one app's shutdown racing another's live detection.

  `_dispatch` now reads a single immutable tuple, replaced by whole-object
  assignment under `_HOOK_LOCK` in `install()`/`uninstall()` — the same pattern
  as `Monitor.active_frame()`. No lock in the hook itself, deliberately: it is
  the hottest path in the process (the interpreter raises audit events for
  every library in it, and the hook already costs ~20% of throughput). The
  tuple holds **weak** references, so a dropped app's detector stays
  collectable; a tuple of detectors would have quietly defeated the `WeakSet`.
  An outer `try/except` wraps the whole body regardless, per the project's
  fail-soft rule.
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
