# Plan: Flow-graph redesign (hybrid loop-hub + per-request branches)

**Status: implemented.** The plan below shipped (as a vertical spine rather
than a top-center hub — see `docs/architecture.md` for the as-built design),
plus more that emerged from using it at ~10-way concurrency:

- Slow-motion playback (virtual clock, header speed slider, 0.05×–1.0×)
- Step mode (`▶ step` drains buffered events one loop hand-off at a time)
- Backlog-skip on connect (only live post-connect events animate)
- Collapsible trees (default: active call-path chain only, "[+N]" badge)
- Variable-height rows stacked in arrival order + vertical scroll
- Finished requests persist instead of fading, plus a "clear" button
- Green "✓ finished" tag on a finished request's root node
- Tooltip await-state label: "awaiting X" vs. "await complete: X"
- Short dashed "⇢ pool" stub for offloaded nodes (instead of a full-canvas edge)
- Filename-scoped global `sys.monitoring` (self-pruning via `DISABLE`)

## Context

The first dashboard (abstract lanes + pool grid) did not convey the mental model.
What we actually want: a **live system-design flow-graph**. A central **EVENT LOOP**
hub; each in-flight request spawns its own **branch** = its full nested call tree
(handler → nested calls → `await` points). The node currently executing lights up
(only one request holds the loop at a time); a suspended request's branch **parks**
(dims) at the `await` node it is waiting on; sync work goes to a **threadpool**
cluster that can show several workers busy at once (real parallelism, visually
distinct from the single loop). Requests fade out after they finish.

Delivery: Python package + browser dashboard (unchanged attach: `visualize(app)`).
Trace depth: **full nested call tree** of the app's own code.

This requires (a) a richer event model (call-tree + await labels + loop occupancy)
and (b) a new canvas graph renderer. Backend collector/WebSocket/identity plumbing
is reused.

---

## Event model (SHARED CONTRACT — backend emits, frontend consumes)

`Event(t, kind, trace_id, task_id, name, extra)` unchanged shape. WS frame unchanged:
`{"events":[event.to_dict(), ...]}`. New/changed `kind` values and their `extra`:

| kind            | extra fields                                                            | meaning |
|-----------------|-------------------------------------------------------------------------|---------|
| `request_start` | `{method, path}`                                                        | branch root created for this trace_id |
| `request_end`   | `{}`                                                                     | request finished; branch may fade out |
| `call_enter`    | `{node_id:int, parent_id:int\|null, qualname, file, line, is_async:bool}`| entered a function frame (a graph node) |
| `call_exit`     | `{node_id:int}`                                                          | that frame returned/unwound |
| `suspend`       | `{node_id:int, awaiting:str}`                                           | frame hit `await` and yielded the loop (parks) |
| `resume`        | `{node_id:int}`                                                         | frame resumed on the loop |
| `offload_start` | `{node_id:int}`                                                          | a sync call was offloaded to the threadpool |
| `offload_end`   | `{node_id:int}`                                                          | offloaded call returned |
| `pool_sample`   | `{borrowed:int, total:int, queued:int}`                                 | threadpool occupancy (emit only on change) |

- **node_id**: a global monotonically-increasing int assigned at `call_enter`,
  matched by `call_exit`. Parent = the node_id on top of the owning task's call
  stack at enter time (null for the request root's first frame).
- **Loop occupancy is derived client-side**: the request whose most recent event is
  a `resume`/`call_enter` (not followed by a `suspend`) is the one holding the loop.
- `name` on every event = short qualname for convenience; authoritative fields live
  in `extra`.

---

## Backend changes

### monitor.py — full nested app-code tracing (rewrite)
- Switch from per-endpoint `set_local_events` to **global events** for
  `PY_START`, `PY_RETURN`, `PY_UNWIND`, `PY_YIELD`, `PY_RESUME`.
- **Scope by filename, self-pruning:** in each callback, if `code.co_filename` is NOT
  under a configured project root → `return sys.monitoring.DISABLE` (permanently stops
  monitoring that location — kills stdlib/site-packages overhead). If under root but
  there is no active request (`current_trace()` is None) → `return` (leave enabled,
  emit nothing). If under root AND in a request → record.
- **Roots**: default to the directory of the module that called `visualize()` (and the
  package that defines the app). Accept `visualize(app, roots=[...])` override. Store as
  normalized absolute path prefixes.
- **Per-task call stack** for node ids: keep `task._viz_stack: list[int]` and a module
  global counter. `PY_START` → new node_id, parent = top of stack (or None), push,
  emit `call_enter`. `PY_RETURN`/`PY_UNWIND` → emit `call_exit`, pop. `PY_YIELD` →
  emit `suspend` for top-of-stack node with `awaiting` label (best-effort: the
  qualname of the frame, or the awaited object's repr if cheaply available — keep it
  cheap/fail-soft). `PY_RESUME` → emit `resume` for top-of-stack node.
- `is_async`: `bool(code.co_flags & CO_COROUTINE)` (0x80) — feature-detect.
- Everything fail-soft (callbacks never raise). `uninstall()` resets `set_events(...,0)`,
  unregisters, frees tool id.

### identity.py — request root
- `TraceMiddleware` already mints trace + stamps task. Change: emit `request_start`
  `{method, path}` at entry and `request_end` at exit (replaces the old
  `task_start`/`task_return`). Ensure a fresh `task._viz_stack = []` per request.
- Task factory still copies `_viz_trace` AND a reference so child tasks share the
  branch (copy `_viz_trace`; child gets its own `_viz_stack`).

### threadpool.py — offload attribution (best-effort)
- Keep on-change `pool_sample`. Additionally wrap `anyio.to_thread.run_sync` OR detect
  offload via monitoring: when a `def` endpoint is called, Starlette calls
  `run_in_threadpool`. Emitting precise `offload_start/end` per request across the
  thread boundary is the known-hard part — MVP of the redesign: emit `offload_start`
  when the endpoint frame is a sync def (detected at `call_enter`, `is_async=False` at
  request root level) and `offload_end` at its `call_exit`; the pool cluster also shows
  aggregate `pool_sample`. Note limitation in code comment.

### app.py
- Pass roots to `Monitor`. Rewire startup to install global-event monitor. Serve the
  new static bundle. WS + collector unchanged.

### events.py
- Update kind constants to the new set. Keep `Event`/`to_dict`.

---

## Frontend rewrite — static/dashboard.js + index.html

Canvas, vanilla JS. Replace lanes+pool with the hybrid graph.

**State from events:** per trace_id a branch object: `{root, nodesById, order, holdsLoop,
suspendedAt, done, lastT}`. Each node: `{id, parent_id, qualname, is_async, state:
running|suspended|done, children:[]}`. `pool` = latest sample.

**Layout & render (requestAnimationFrame):**
- Central **EVENT LOOP** hub node, top-center. Pulses; shows count of live requests and
  which one currently holds the loop (highlighted edge/color).
- Each live request = a branch fanned below the hub: request root node (`METHOD path`),
  then its call tree laid out top-down (parent above, children indented/stacked). Edges
  drawn parent→child.
- Node states: **running** = bright fill (hue per trace_id); **suspended** = dimmed +
  a pause glyph, and its edge to the hub goes faint (parked, loop moved on); **done** =
  fade out over ~1s then drop.
- The node currently on the loop gets a glow ring; the hub highlights that branch.
- **Threadpool cluster**: a boxed group of `total` worker cells to one side; fill
  `borrowed` (green, red at saturation); offloaded request nodes draw an edge into the
  cluster instead of parking (shows genuine parallelism vs the single loop).
- Keep the **load driver** header bar (path + count + fire) and connection status.
- Idle hint when no live requests.

**Interaction (nice-to-have, keep light):** hover a node → tooltip with
qualname/file:line. Not required for v1 if time-boxed.

---

## Tests
- `tests/test_backbone.py`: assert `request_start`, `call_enter`/`call_exit` nesting
  (a parent_id chain forms a tree), `suspend`/`resume` present, multiple trace_ids.
- `tests/test_threadpool.py`: sync endpoint → `pool_sample` borrowed>0 (+ `offload_*`
  if implemented).
- Keep assertions timing-robust.

## Verification
1. `uv run pytest` green.
2. `uv run uvicorn examples.demo:app` → `/_viz`; click fire on `/async` (count 10):
   watch branches sprout off the loop hub, one lit at a time, others parked at
   `await asyncio.sleep`. Fire `/sync` (count 60): threadpool cluster fills to 40 + red.
3. Headless replay check (reconstruct tree from WS) as a sanity gate before browser.

## Out of scope (later)
- VS Code extension delivery.
- Precise cross-thread offload attribution beyond best-effort.
- Historical scrub/replay.
