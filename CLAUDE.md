## Project

Dev tool that visualizes a FastAPI app's async internals as a live flow-graph:
the event loop drawn as a vertical spine, one row per in-flight request
showing its nested call tree, await suspend/resume, and threadpool offload —
in a browser dashboard. `visualize(app)` mounts it at `/_viz`. Header controls:
load path/count + `fire` (built-in load driver), `speed` (slow-motion
playback), `max req` (row cap), `step` mode, `clear`.

## Commands

Always use `uv`, never call `pip`/`python` directly.

- Install/sync: `uv sync`
- Add a dep: `uv add <pkg>` / `uv add --dev <pkg>`
- Run any command: `uv run <cmd>`
- Run the demo: `uv run uvicorn examples.demo:app --reload`, then open
  http://127.0.0.1:8000/_viz
- Tests: `uv run pytest`

## Docs map

- Design & mechanisms: `docs/architecture.md`
- Active/planned work: `docs/plans/`
- Notable changes: record under `docs/changelog.md` `[Unreleased]`
- Original design spec (reference, **do not edit**): `doc/fastapi-async-visualizer-plan.md`

## Constraints

- Python **3.12+ only** — per-await tracing requires `sys.monitoring` (PEP 669).
- Instrumentation must be **fail-soft**: wrap every `sys.monitoring` callback,
  limiter read, task-factory hook, and collector fan-out in try/except so a
  tracing error never breaks a request.
- Feature-detect version-sensitive internals (task-factory shape, limiter
  attributes) rather than assuming a fixed shape.
- Dashboard is vanilla JS + canvas, no build step, no external CDNs — must
  work fully offline.

## Conventions

- Update `docs/changelog.md` `[Unreleased]` when adding features.
- Keep the dashboard bundle prebuilt — no build step required of the user.
- Prefer pure-ASGI middleware over `BaseHTTPMiddleware` — it breaks
  contextvar propagation.
