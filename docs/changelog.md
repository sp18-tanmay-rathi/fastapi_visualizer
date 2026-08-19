# Changelog

All notable changes to this project are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

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
