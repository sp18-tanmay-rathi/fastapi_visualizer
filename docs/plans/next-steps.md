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

Tag `v0.1.0` only when ALL of these hold:

- async-generator dependencies (`async def ... yield`, e.g. `get_db`) are
  classified as async on the loop, not offloaded (task 6);
- sync endpoints are visually separated from async requests (task 5);
- loop-holder is never attributed to threadpool work (tasks 5 + 6);
- blocking async code is visibly detected (task 3);
- custom-lifespan apps work (already fixed; covered by a test in task 1);
- a monitoring failure cannot break the application (fail-soft; test in task 1);
- `roots` scoping works (test in task 1);
- the visualizer is disabled by default outside debug mode (task 7);
- the multi-worker limitation is clearly surfaced (task 9);
- `uv run pytest` passes and CI passes on 3.12/3.13/3.14 (tasks 1, 13A);
- README documents installation + limitations, with a screenshot/GIF (13A).

PyPI publishing (13B) is explicitly NOT part of v0.1.0 — see Phase 5.

---

## Execution roadmap (phases)

- **Phase 1 — Correctness (make the existing system trustworthy):**
  6 → 1 → 5 → 4
- **Phase 2 — Teaching feature:** 3
- **Phase 3 — Safety (safe to hand to another dev):** 7 (incl. former 8) → 9 → 12
- **Phase 4 — Adoptable + release:** 13A → 2
- **Phase 5 — Perf / config / polish (only after the model is proven):**
  10 → 11 → 14 → 13B

Rationale: task 6 is a real classification bug AND a prerequisite for task 5's
zone split, so it's first. Tests (1) come immediately after so every later
change lands on a safety net. Task 5 is treated as **conceptual correctness**
(it changes the mental model the tool teaches), not UI polish. Task 4 gets much
simpler once 5 removes sync work from the loop-holder logic. Sampling/config
(10/11) wait until benchmarks show a real problem — filename-scoped monitoring
with `DISABLE` already trims most overhead, so don't optimize blind.

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

---

# Phase 2 — Teaching feature

## 3. Blocking detection (original milestone 3)

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

## 7. Production safety (merges former 7 + 8) ★

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

- **Self-overhead:** cheap running counter of time in monitoring callbacks;
  surface an approximate "tracing overhead" figure in the header.
- **Sampling:** `sample=` (default 1.0). Decide at `request_start`, tag the
  whole trace in/out; non-sampled requests emit nothing.

Files: `identity.py`, `monitor.py`, `app.py`, `static/*`.
**Done-check:** `sample=0.1` traces ~10%; header shows a non-zero overhead
figure under load.

## 11. Config surface (split: core lands with earlier tasks, rest here)

Don't add all args at once. **Core** args already arrive with their features:
`roots` (done), `path="/_viz"` (remount), `enabled` (task 7). This task adds
the **remaining** knobs once their features exist: `sample` (task 10),
`slow_ms` (task 3), `token` (task 12) — so `app.py` doesn't become a dumping
ground. Also improve `roots` defaulting for `src/` layouts / multi-package
repos (walk to nearest package root, or accept package names).

Files: `app.py`, `monitor.py`, `README.md`.
**Done-check:** each arg takes effect; `path="/debug/viz"` remounts there.

## 14. Feature polish (nice-to-have)

- Status code + duration on the ✓ finished tag (needs `request_end.extra =
  {status, duration_ms}` from the middleware).
- Filter/search rows by path substring.
- Hover a qualname → highlight it across all requests.
- Optional `X-Request-ID` response header carrying the trace id (default off).

Files: `identity.py`, `static/*`.
**Done-check:** finished tag shows `200 · 42ms`; filter box hides non-matching
rows.

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
