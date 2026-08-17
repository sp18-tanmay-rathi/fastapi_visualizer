# MVP Plan

Future plans live beside this file in `docs/plans/`.

**Status: done.** The visualization itself has since been redesigned into a
live flow-graph — see `docs/plans/graph-redesign.md` and
`docs/architecture.md`.

## In scope (this build)

- [x] Event backbone — `sys.monitoring` `PY_YIELD`/`PY_RESUME` + task-factory
      identity + monotonic timing → event log
- [x] Threadpool reader — poll AnyIO `CapacityLimiter` → `pool_sample` events
- [x] Collector + WebSocket stream — bounded ring buffer, batched frames
- [x] Rough dashboard — lanes panel + pool grid panel (since replaced by the
      flow-graph redesign)
- [x] Demo app — endpoints that exercise async awaits and sync offload
- [x] Tests — backbone + threadpool

## Deferred (post-MVP)

- [ ] Blocking detection (`set_debug` + `slow_callback_duration` → flash the
      loop red) — *milestone 3; needs the loop-holder concept from milestone 4
      landed first to attribute the culprit request*
- [ ] Event-loop-holder / waiters panel B (`current_task`/`all_tasks`) —
      *milestone 4; not required to prove the core suspend/resume + pool
      story that the MVP targets*
- [ ] Built-in load driver button — *milestone 6; external load (httpx/locust)
      is sufficient to demo the MVP*
- [ ] Sampling under load + self-overhead readout + scope toggles —
      *milestone 7; only matters once event volume becomes a real problem*
- [ ] Per-request offload attribution across the `run_in_threadpool`
      boundary — *contextvars don't cross threads cleanly; needs explicit
      propagation design beyond MVP scope*

Source spec: `doc/fastapi-async-visualizer-plan.md` (§7 build order).
