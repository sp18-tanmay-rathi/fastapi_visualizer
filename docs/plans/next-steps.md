# Implementation Tasks — next steps

Prioritized, actionable work. Organized into **phases** so the list doesn't
read as 14 equally-urgent items — it's really three categories: correctness
bugs (must fix), safety / package-readiness (before wider use), and
features / polish (can wait).

**Hard constraint (applies to all UI work):** the dashboard is **view-only**.
It never issues requests to the visualized app — no `fetch`, no load/fire
button, no JWT entry. All traffic is driven externally (real user actions,
curl, httpx, a load tool). Do not reintroduce any API-calling control.

---

## Definition of Done — v0.1.0

**Status:** everything below holds EXCEPT the three marked ✗ — task 9's
multi-worker *banner* (the limitation is documented in `README.md` and
`docs/architecture.md`, but nothing detects the case at runtime), task 12's auth
token, and CI + the README screenshot from 13A. Do not tag `v0.1.0` until those
land.

Tag `v0.1.0` only when ALL of these hold:

- async-generator dependencies (`async def ... yield`, e.g. `get_db`) are
  classified as async on the loop, not offloaded (task 6);
- sync endpoints are visually separated from async requests (task 5);
- loop-holder is never attributed to threadpool work (tasks 5 + 6);
- blocking async code is visibly detected (task 3);
- custom-lifespan apps work (already fixed; covered by a test in task 1);
- a monitoring failure cannot break the application (fail-soft; test in task 1);
- `roots` scoping works (test in task 1);
- child-task trace propagation is tested (task 1);
- events carry monotonic sequence numbers and event loss is detectable (task 15);
- loop state distinguishes running / waiting / untraced / done (task 4);
- the visualizer is disabled by default outside debug mode (task 7) — **done**;
- the multi-worker limitation is clearly surfaced (task 9) — **✗ documented
  only, no runtime banner**;
- `uv run pytest` passes and CI passes on 3.12/3.13/3.14 (tasks 1, 13A) —
  **✗ pytest passes (29 tests); CI not set up**;
- README documents installation + limitations, with a screenshot/GIF (13A) —
  **✗ documented, no screenshot/GIF yet**.

PyPI publishing (13B) is explicitly NOT part of v0.1.0 — see Phase 5.

---

## Execution roadmap (phases)

- **Phase 1 — Correctness (make the existing system trustworthy):**
  6 → 1 → 15 → 5 → 4 — **DONE**
- **Phase 2 — Teaching feature:** 3 — **DONE**
- **Phase 3 — Safety (safe to hand to another dev):** 7 (incl. former 8) → 9 → 12
  — **7 DONE; 9 and 12 deliberately deferred**, so this phase is NOT closed.
- **Phase 4 — Adoptable + release:** 13A → 2 — blocked (see Definition of Done)
- **Phase 5 — Perf / config / polish (only after the model is proven):**
  10 → 11 → 14 → 17 → 18 → 19 → 13B — **14 DONE** (pulled forward, out of
  phase order, because it needed nothing from 10/11); rest open.

Rationale: task 6 is a real classification bug AND a prerequisite for task 5's
zone split, so it's first. Tests (1) come immediately after so every later
change lands on a safety net. Task 15 (sequence numbers) lands in Phase 1 too:
building more UI on a stream that can silently drop structural events
(`call_enter` without `call_exit`) reconstructs impossible state — make loss
detectable before trusting the model. Task 5 is treated as **conceptual
correctness** (it changes the mental model the tool teaches), not UI polish.
Task 4 gets much simpler once 5 removes sync work from the loop-holder logic,
and it now also formalizes explicit runtime states (RUNNING / WAITING /
UNTRACED / DONE) so the UI never looks more certain than the instrumentation
is. Sampling/config (10/11) wait until benchmarks show a real problem —
filename-scoped monitoring with `DISABLE` already trims most overhead, so don't
optimize blind.

> **Doc provenance:** this file is the single source of truth. It absorbed an
> external review (correctness-first spine, seq numbers, explicit states,
> status_code, inspector, child-task branches, module split, replay tests,
> benchmark matrix, per-app collector); that separate review doc has since been
> removed.

---

# Phase 1 — Correctness

## 6. Fix async-generator misclassification / bogus offload (bug) — FIRST

`get_db` (an `async def ... yield` dependency) wrongly renders as offloaded to
the threadpool (`⇢ pool`). It runs on the event loop — FastAPI only offloads
sync `def` dependencies. Two bugs in `monitor.py`:

- **Async detection misses async generators.**
  `is_async = bool(code.co_flags & CO_COROUTINE)` only tests `CO_COROUTINE`
  (0x80). An async generator's flag is `CO_ASYNC_GENERATOR` (0x200), so any
  `async def` with a `yield` reads `is_async=False`.
  **Fix:** `is_async = bool(code.co_flags & (0x80 | 0x200))`. Keep the
  constants named / feature-detected.
- **Offload heuristic misfires.** The rule
  `if parent_id is None and not is_async: emit OFFLOAD_START` trips for
  `get_db` (empty stack → parent_id None, plus the wrong `is_async`). It's
  guessing.
  **Fix:** detect offload from the TRUE signal already available — threadpool
  work runs on a worker thread where `asyncio.current_task()` is `None`
  (`_stack()` already returns `task=None` there). Mark a frame offloaded iff it
  runs with no current asyncio task. Precise; won't misfire on loop-run async
  generators.

This classification (async vs offloaded) is the SAME signal task 5 uses to sort
requests into the loop vs threadpool zones — so it must be right first.

Files: `monitor.py`; regression test in task 1.
**Done-check:** an endpoint depending on `get_db` shows `get_db` as an async
node on the loop (no `⇢ pool`); a sync `def` endpoint still shows
`offload_start` / `⇢ pool`.

## 1. Backend regression tests — SECOND (right after 6)

Only 2 tests exist today, both driving the app via
`app.router.lifespan_context`. Add tests **before** the safety/zone/frontend
work so those land on a net. Cover exactly the fragile areas:

- **Offload classification (guards task 6):** an `async def ... yield`
  dependency must NOT emit `offload_start`; a sync `def` endpoint MUST.
- **Custom-lifespan install path:** an app built with `FastAPI(lifespan=...)`
  still installs the monitor and produces `call_enter` events (the regression
  the lifespan-wrap fix addressed).
- **Monitoring-conflict degrade:** occupy all `sys.monitoring` tool ids (or
  monkeypatch `use_tool_id` to raise); assert no crash and
  `request_start`/`request_end` still flow (fail-soft).
- **Nested-tree shape:** a known chain reconstructs — parent_id links form a
  tree; every `call_enter` node_id has a matching `call_exit`.
- **suspend/resume pairing:** each `suspend` for a node is followed by a
  `resume` or `call_exit` for the same node_id.
- **roots scoping:** a file outside `roots` produces no `call_enter`; one
  inside does.
- **child-task trace propagation:** an endpoint that `asyncio.create_task()`s
  child work — assert children inherit the request `trace_id` (task factory)
  yet keep independent `task_id` / stacks (guards task 17's rendering).

Files: `tests/` (new cases + shared fixture helper). Timing-robust assertions
(counts ≥ thresholds, not exact).
**Done-check:** `uv run pytest` green; deliberately breaking the lifespan wrap
fails the custom-lifespan test; reverting task 6 fails the offload test.

## 5. Separate sync (threadpool) from async (loop) requests — CORRECTNESS

Not UI polish: a sync `def` runs on a **worker thread**, not the loop, so
grouping it under the EVENT LOOP spine teaches the wrong model and currently
misleads (its `call_enter` sets `loopHolder`, glowing the loop for a request
that isn't on it). Fix = **two zones**.

Confirmed target layout:

```
EVENT LOOP (1 thread)
 │● #a1 GET /async  ▶ db.fetch ⏸
 │  #b2 GET /list   ▶ query ◀ running
─────────────────────────────────────
THREADPOOL (worker threads, real parallel)
 │▪ #c3 GET /report ▶ heavy_calc ◀ thread
 │▪ #d4 POST /img    ▶ resize ◀ thread
```

- **Top zone — EVENT LOOP spine (async):** root frame is a coroutine.
  Unchanged rendering: loop-holder glow, ⏸ parked awaits, one-runs-at-a-time.
- **Bottom zone — THREADPOOL spine (sync):** root frame is offloaded (the
  `offload_start` / worker-thread signal from task 6). Full call tree, rooted
  on the pool section. Multiple sync requests run at once here (real
  parallelism) — they do NOT share the single-holder rule.

**Backend:** already sufficient after task 6 (root `is_async` + worker-thread
offload signal). Nice-to-have: stamp `request_start.extra.kind =
"async"|"sync"` so the frontend classifies without waiting for the first
`call_enter` — decide during impl.

**Frontend (`dashboard.js` + `index.html`):**
- Classify each branch `zone: "loop" | "pool"`; default "loop" until known,
  reclassify on the first classifying event.
- Split the canvas into two stacked regions, each with its own spine/header.
  Keep variable-height rows + collapse + vertical scroll (shared or per-zone —
  simpler that stays legible).
- **Loop-holder claim applies to the LOOP zone only.** Pool-zone branches never
  set/steal `loopHolder`; their nodes render active but the loop glow is driven
  solely by async branches. (This also fixes the sync-claims-the-loop
  inaccuracy noted in task 4.)
- Threadpool cluster box (borrowed/total) stays; belongs beside/within the pool
  zone; offloaded nodes connect to it.
- Legend: "loop = one at a time; threadpool = several threads truly run at
  once".

Files: `static/dashboard.js`, `static/index.html`, maybe `identity.py`
(root-kind hint), `examples/demo.py`, `docs/architecture.md`,
`docs/changelog.md`.
**Done-check:** async endpoint → row under EVENT LOOP with holder glow; sync
endpoint → row under THREADPOOL with no loop glow; several sync requests show
multiple simultaneously "running" pool rows while the loop zone stays idle.

## 4. Loop-holder blind-spot honesty

Much simpler after task 5 (sync work already out of loop-holder logic). The
remaining issue: the highlight is blind while the loop runs untraced code
(stdlib, site-packages, loop internals); today the marker sticks on the last
holder, reading as "still running" when it's actually in library code.

- **Client-side:** track the timestamp of the last applied in-root event for
  the current holder. If playback time advances past it beyond a small
  threshold with no new event for that trace, show the spine marker in a
  distinct "loop: elsewhere / untraced" style (dimmed + label) instead of the
  bright holder glow. Clear it on the next in-root event for any trace.
- Legend row explaining the "untraced" state so it doesn't look broken.
- Purely visual — no backend change. (Optional backend heartbeat later; avoid
  the overhead for now.)

Files: `static/dashboard.js`, `static/index.html`, `docs/architecture.md`
(update the derived-vs-measured section).
**Done-check:** a request awaiting a real DB/network call (untraced client lib)
shows the spine as "untraced" during the wait, not as a bright holder; back to
bright when in-root code runs.

**Formalize runtime state (from the fix-plan review):** don't derive the loop
holder ad-hoc from "most recent event". Give each request an explicit state —
`RUNNING` / `WAITING` / `UNTRACED` / `DONE` (add `UNKNOWN` if needed) — and
render that. `UNTRACED` is exactly the blind-spot case above: last in-root event
handed control outside `roots` and no new in-root event has re-established
position. This makes measured state visually distinct from inferred state; the
README must state the distinction. Tests cover the transitions.

## 15. Event sequence numbers + drop visibility — Phase 1 reliability

`Collector` uses bounded buffers (ring 5000, per-subscriber queue 1000) and
**silently drops oldest on overflow**. A dropped structural event corrupts the
stream — e.g. `call_enter(42)` dropped but `call_exit(42)` delivered, or
`suspend(17)` dropped before `resume(17)` — and the frontend reconstructs an
impossible state with no signal that anything is wrong. Fix before stacking more
UI on the model.

- **Backend:** add a process-wide monotonic `seq: int` to `Event`, assigned
  centrally in `Collector.push()` (single authoritative ordering). Keep the
  producer path non-blocking; never wait on a slow browser subscriber. Track a
  per-subscriber dropped-event counter. Optionally surface it in the WebSocket
  frame envelope: `{events, first_seq, last_seq, dropped_before}`.
- **Frontend:** track the last received `seq`; if the next frame's `first_seq`
  skips ahead (or `dropped_before > 0`), mark the stream gapped and show a
  non-invasive banner: "⚠ N events dropped — this trace may be incomplete."
  Prefer degrading gracefully over asserting a reconstructed-but-wrong tree.

Files: `events.py`, `collector.py`, `app.py`, `static/dashboard.js`, tests.
**Done-check:** every emitted event has an increasing `seq`; a forced overflow
is detected client-side and banners; a test asserts monotonic ordering.

---

# Phase 2 — Teaching feature

## 3. Blocking detection (original milestone 3) — **DONE**

Shipped as designed: retrospective per-interval measurement in `monitor.py`
(`_loop_open`/`_loop_close`), `loop_blocked`/`loop_unblocked` stamped at the real
span boundaries, `slow_ms` threshold on `visualize()`, red spine flash + node
glow + a durable per-row "🔥 blocked" tag, and a `/blocking` demo endpoint.
Building it also flushed out four unrelated bugs — see the changelog's Fixed
section (collector thread-safety, spurious drop banner, over-cap traces never
reappearing, step mode stalling on threadpool traffic, Ctrl+C needing two
presses).

Surface the key teaching failure: sync/CPU work inside an `async def` that
freezes the whole loop.

**Measurement definition (important — get this right):** there is NO monitoring
event during a `time.sleep(0.3)` inside a coroutine; the monitor only sees
`PY_START` … (300ms) … `PY_RETURN`. So do NOT model it as "start → blocked →
resume". Define it as:

> Measure elapsed wall time between the last monitoring boundary at which a
> frame became active and the next monitoring boundary for that frame. If the
> elapsed duration exceeds the threshold and the frame did not yield during the
> interval, classify the interval as a blocking span.

**Backend**
- `sys.monitoring` is the PRIMARY source (matches the architecture's
  "monitoring events are measured facts" stance). Track per-active-frame
  wall-time between boundaries; when an in-root frame's interval exceeds the
  threshold without yielding, emit `loop_blocked{node_id, duration}` and a
  matching `loop_unblocked` when it yields/returns. Fail-soft.
- asyncio's slow-callback logging is at most a SECONDARY signal — only if
  testing shows it adds value. Do not make it the primary implementation.
- Add kinds `LOOP_BLOCKED` / `LOOP_UNBLOCKED` to `events.py`.
- Threshold via `slow_ms=` (default 100), part of the config surface (task 11).

**Frontend**
- A node in a blocking span: hot red border/glow; flash the EVENT LOOP spine
  red with "BLOCKED by <qualname> (Ns)".
- Legend row: "🔥 blocking the loop — sync/CPU work in an async path".

**Demo**
- Add a `/blocking` endpoint to `examples/demo.py`: an `async def` doing a real
  `time.sleep(0.3)`.

Files: `events.py`, `monitor.py` (or a timing helper), `app.py` (threshold),
`static/dashboard.js` + `index.html` (legend), `examples/demo.py`,
`docs/architecture.md` + `docs/changelog.md`.
**Done-check:** hitting `/blocking` turns that node + the spine red; a normal
`await asyncio.sleep` request does NOT.

---

# Phase 3 — Safety

## 7. Production safety (merges former 7 + 8) ★ — **DONE**

Shipped: `enabled=` resolved before anything is touched (explicit > `FASTAPI_VIZ`
> `app.debug`); when off, nothing is installed or mounted and
`app.state._viz == {"enabled": False}`; `loop.set_debug(True)` removed entirely
(blocking detection never needed it). Tests in `tests/test_enable.py`; the suite
opts in via an autouse fixture in `tests/conftest.py`.

One contract: **never silently alter production/application behavior, and don't
expose internals unless explicitly enabled.**

- Add `enabled=` to `visualize(app, enabled=None)`. Default (None) = auto: on
  when `app.debug` is true OR env `FASTAPI_VIZ=1`; off otherwise.
- When resolved off, install NOTHING and mount nothing: no monitoring, no task
  factory, no threadpool poller, no `/_viz` mount, and **no
  `loop.set_debug(True)`**. Log one line saying how to enable. Stays
  import-safe / no-op.
- Remove the current unconditional `loop.set_debug(True)` — it changes the
  user's app behavior (slow-callback logging) + overhead. When enabled, only
  set it if blocking detection (task 3) actually needs it, and document that.

Files: `app.py`, `README.md`, `docs/architecture.md`, `docs/changelog.md`.
**Done-check:** `debug=False`, no env flag → no `/_viz`, no monitor, loop debug
state untouched; `FASTAPI_VIZ=1` or `enabled=True` turns it on.

## 9. Multi-worker awareness (warning only — do NOT build aggregation)

`uvicorn --workers N` = N processes, each its own loop + in-memory collector;
the dashboard only sees the worker that served `/_viz`, so most traffic looks
missing. This limitation is inherent to the in-memory collector — a simple
warning is enough; do not turn this into a distributed tracing system.

- Detect the multi-worker case where feasible (`WEB_CONCURRENCY`, observed
  PID); show a dashboard banner + startup log: "showing only worker PID X; run
  a single worker to see all traffic".
- Document the single-worker recommendation.

Files: `app.py` (detect + log), `static/*` (banner), `README.md`,
`docs/architecture.md`.
**Done-check:** `--workers 2` shows the banner; single worker does not.

## 12. Dashboard auth option (optional, simple)

Dashboard + WebSocket are unauthenticated — anyone reaching the port sees all
paths + source structure. Keep the fix minimal (dev tool, not user management).

- Optional `token=`: when set, `/_viz` and `/_viz/ws` require it (query param
  `?token=...` or header); without it → 401. Default None = open (dev
  convenience), documented. Make the boundary explicit: None = dev; set =
  protected. No sessions/accounts.

Files: `app.py`, `static/*` (pass token on WS connect), `README.md`.
**Done-check:** with a token set, `/_viz` without it is 401; with it, loads.

---

# Phase 4 — Adoptable + release

## 13A. Repository hygiene (before release)

- **LICENSE** file (none exists) — pick one (MIT?) + add `license` to
  `pyproject.toml`.
- **README screenshots / GIF** of the live dashboard (loop spine + await
  parking + step mode) — it's a visual tool; text-only undersells it. Ensure
  installation + limitations are documented.
- **CI** (GitHub Actions): `uv run pytest` on 3.12/3.13/3.14 + `ruff` + a type
  check.

Files: `LICENSE`, `pyproject.toml`, `.github/workflows/ci.yml`, `README.md`.
**Done-check:** CI green on all three Pythons; README renders a GIF + limits.

## 2. Tag v0.1.0

Only after Phase 1–3 + 13A, and only when the Definition of Done above holds —
don't declare the architecture stable while known correctness issues remain.

- Complete the changelog `[Unreleased]`, cut `## [0.1.0] - <date>`.
- `git tag -a v0.1.0 -m "..."` + `git push origin v0.1.0`.
- README: document pinning
  `uv add "git+https://github.com/tanmayrathi-sp18/fastapi_visualizer@v0.1.0"`;
  optionally update rentbnb to the tag.

**Done-check:** `v0.1.0` on the remote; `uv add ...@v0.1.0` resolves to it.

---

# Phase 5 — Perf / config / polish (only after the core model is proven)

## 10. Overhead readout + sampling (only if benchmarks justify it)

Don't build before measuring — filename-scoped monitoring with
`sys.monitoring.DISABLE` already trims out-of-root overhead. After Phase 1–3,
benchmark; only if overhead is real:

- **Benchmark matrix first (§25):** because `sys.monitoring` hooks run in the
  interpreter, measure before adding callbacks. Compare (1) no visualizer,
  (2) installed-but-disabled, (3) enabled + roots scoping, (4) enabled +
  dashboard connected, (5) under concurrent load. Track rps, p50/p95/p99
  latency, CPU, memory, events/sec. Don't optimize on intuition.
- **Self-overhead:** cheap running counter of time in monitoring callbacks;
  surface an approximate "tracing overhead" figure in the header.
- **Sampling:** `sample=` (default 1.0). Decide at `request_start`, tag the
  whole trace in/out; non-sampled requests emit nothing.

Files: `identity.py`, `monitor.py`, `app.py`, `static/*`.
**Done-check:** `sample=0.1` traces ~10%; header shows a non-zero overhead
figure under load; benchmark numbers recorded before/after.

## 11. Config surface (split: core lands with earlier tasks, rest here)

Don't add all args at once. **Core** args already arrive with their features:
`roots` (done), `path="/_viz"` (remount), `enabled` (task 7). This task adds
the **remaining** knobs once their features exist: `sample` (task 10),
`slow_ms` (task 3 — **done**), `token` (task 12) — so `app.py` doesn't become a
dumping ground.

**Core args landed:** `roots`, `slow_ms`, `enabled`, `path` (remount —
normalized, root mount rejected, frontend derives its socket URL from
`location.pathname`), plus `correlate_request_id` / `expose_request_id` from
task 14. Still open here: `sample` (needs task 10), `token` (needs task 12), and
the better `roots` defaulting for `src/` layouts. Also improve `roots` defaulting for `src/` layouts / multi-package
repos (walk to nearest package root, or accept package names).

Files: `app.py`, `monitor.py`, `README.md`.
**Done-check:** each arg takes effect; `path="/debug/viz"` remounts there.

## 14. Feature polish (nice-to-have) — **DONE** (all 7 sub-items)

Shipped: duration + status code (via an ASGI `send` wrapper, no body
buffering) on `request_end.extra`; request inspector as a DOM overlay opened by
a row click; trace ids widened to `token_hex(8)` with a 6-char row display;
`path:`/`status:`/`slow:`/`zone:` row filter; hover-to-highlight the same
qualname across rows; `correlate_request_id` + `expose_request_id`. Tests in
`tests/test_request_meta.py`.

- **Request duration:** derive `wall = request_end.t - request_start.t`
  (timestamps already monotonic). Show next to each request; flag/color slow
  ones over a configurable threshold. Frontend-derived first; add a semantic
  `RequestTrace` model only if request-level features grow.
- **Status code:** `TraceMiddleware` emits method/path but not status. Wrap the
  ASGI `send` to observe `http.response.start` and record `status_code` WITHOUT
  buffering the body; stamp `request_end.extra = {status, duration_ms}`.
- **Request inspector panel:** click a request row → method, path, trace id,
  task id, start/end, duration, status, exception state, #call nodes,
  #suspensions, #blocking events, execution zone. Turns raw events into a
  readable latency/exec profile.
- **Stronger request id (§11):** `_next_trace_id()` uses `secrets.token_hex(3)`
  (6 hex) — fine for the demo, weak under load. Widen to `token_hex(8)` (or
  UUID) internally; keep the short display in the UI. Optional: correlate with
  an inbound `X-Request-ID` header when present (don't replace the generated id
  unless configured).
- Filter/search rows: `path:/checkout`, `status:500`, `slow:true`,
  `zone:threadpool`. Keep it simple substring/keyword — no query language yet.
- Hover a qualname → highlight it across all requests.
- Optional `X-Request-ID` response header carrying the trace id (default off).

Files: `identity.py`, `static/*`.
**Done-check:** finished tag shows `200 · 42ms`; inspector opens on row click;
filter box hides non-matching rows.

## 17. Child tasks as separate branches of one trace

`identity.py` already propagates `trace_id` to child tasks and resets their
stacks — right direction, but the frontend can render two concurrent
`asyncio.create_task()` branches as one linear chain, which is wrong. Make the
model explicit: one request (`trace_id`) contains N execution branches keyed by
`task_id`, each with its own call tree. Include `task_id` in request-tree state;
render concurrent children as parallel branches under the same request. Guarded
by the child-task test in task 1.

Files: `static/dashboard.js`, `static/index.html`.
**Done-check:** a request spawning two concurrent child tasks renders as one
request with two concurrent branches, not a single call chain.

## 18. Split `dashboard.js` into modules (maintainability)

`dashboard.js` now does WebSocket, buffering, playback clock, trace state, tree
reconstruction, layout, canvas rendering, interaction, threadpool rendering, and
UI controls in one file. Keep vanilla JS (no-build / offline requirement), but
separate concerns into ES modules loaded by `index.html`:
`static/dashboard/{websocket,events,state,layout,renderer,main}.js`. A build
step stays optional; the goal is maintainability, and it's a prerequisite for
task 19's pure reducer tests.

Files: `static/*`.
**Done-check:** dashboard still works offline; state/reducer logic is importable
in isolation.

## 19. Deterministic frontend event-replay tests — **STARTED**

A first slice exists: `tests/js/playback_test.js` loads the real `dashboard.js`
under a stubbed DOM and drives it via a fake WebSocket + fake rAF clock,
asserting on what reaches the graph (observed through the `#event-count`
element that `ingest()` updates). It caught and now guards the auto-playback
stall. Notably this did NOT require task 18 first — driving the IIFE from
outside works without exports, so 18 is an optional cleanup here, not a
prerequisite. Still to cover: seq gaps (15), multiple tasks per trace (17),
offload events, blocking warnings (3), and duplicate/out-of-order events.
Runner: `tests/test_dashboard_playback.py`, which skips when node is absent.

Once task 18 makes the reducer pure, feed it fixed event sequences and assert
resulting state — no browser needed. Example fixture
(`request_start, call_enter A, call_enter B, suspend B, resume B, call_exit B,
call_exit A, request_end`) → one request, correct parent/child, B suspended then
resumed, A root, request finished. Also cover: seq gaps (task 15), multiple
tasks under one trace (task 17), offload events, blocking warnings (task 3), and
out-of-order / duplicate events rejected safely. Browser automation can come
later.

Files: `static/dashboard/*`, a small JS test harness.
**Done-check:** the reducer produces expected state for each fixture; a gap
fixture flips the dropped-events flag.

## 13B. PyPI publishing (post-v0.1.0, separate cycle)

Deliberately NOT part of v0.1.0. The tool is an internal dev tool first;
publish only after another project has used the tagged git version.

- PyPI metadata in `pyproject.toml`, `uv build`, test the built wheel installs
  clean, `uv publish`.

**Done-check:** `uv add fastapi-visualizer` (bare name) resolves from PyPI.

---

## Out of scope (tracked elsewhere or deferred)

- Per-request threadpool offload attribution beyond best-effort (see
  `threadpool.py` limitation).
- Historical scrub / replay of a past run.
- VS Code extension delivery.
- **Per-app collector (§16):** the module-level `collector = Collector()`
  singleton means every visualized app in one process shares one stream.
  Supported model for now = one visualized app per process (document it). A
  per-app `Collector` on `app.state._viz` is a larger refactor — only after the
  core event model is stable.
- OpenTelemetry mapping, multi-worker aggregation, external-dependency tracing
  (HTTP/DB/Redis), Chrome Trace export — all premature until the event model is
  proven. Layer on after v0.1.x.
