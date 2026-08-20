# Multi-Worker Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when the app runs under multiple uvicorn/gunicorn workers and surface a clear warning — in the startup log and in the dashboard — so the developer knows they're only seeing one worker's traffic.

**Architecture:** Backend detects multi-worker mode via env vars (`WEB_CONCURRENCY`, `UVICORN_WORKERS`) at startup and includes a `meta` object in the first WebSocket frame sent to each connecting client. The frontend reads `frame.meta` on the first message and shows a persistent banner when `multi_worker` is true. No new dependencies.

**Tech Stack:** Python 3.12+, asyncio, vanilla JS, existing Starlette/FastAPI stack.

**Spec:** `docs/plans/next-steps.md` — Task 9 (Phase 3 — Safety)

## Global Constraints

- Python 3.12+ only — project requirement.
- No new dependencies — detection uses stdlib `os` only.
- Dashboard is view-only — no new fetch/API calls.
- Fail-soft — detection errors must never crash startup.
- Vanilla JS, no build step, works offline.
- `uv run pytest` must stay green throughout.
- Commands: `uv run pytest`, `uv run uvicorn examples.demo:app`.

---

## File Map

| File | Change |
|---|---|
| `src/fastapi_visualizer/app.py` | Add `_is_multi_worker()`, startup log, include `meta` in first WS frame |
| `src/fastapi_visualizer/static/index.html` | Add `#multi-worker-warn` banner element + CSS |
| `src/fastapi_visualizer/static/dashboard.js` | Read `frame.meta` on first WS message, show/hide banner |
| `tests/test_multiworker.py` | New — unit tests for `_is_multi_worker()` and meta frame |
| `docs/changelog.md` | Add entry under `[Unreleased]` |

---

## Task 1: Backend detection + startup log

**Files:**
- Modify: `src/fastapi_visualizer/app.py`
- Create: `tests/test_multiworker.py`

**Interfaces:**
- Produces: `_is_multi_worker() -> bool` (module-level in `app.py`) — used by Task 2 and tests

- [ ] **Step 1: Write failing tests**

Create `tests/test_multiworker.py`:

```python
"""Tests for multi-worker detection."""

import os
import importlib
from unittest.mock import patch


def test_single_worker_by_default():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("WEB_CONCURRENCY", None)
        os.environ.pop("UVICORN_WORKERS", None)
        assert _is_multi_worker() is False


def test_web_concurrency_one_is_single():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"WEB_CONCURRENCY": "1"}, clear=False):
        assert _is_multi_worker() is False


def test_web_concurrency_multi():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"WEB_CONCURRENCY": "4"}, clear=False):
        assert _is_multi_worker() is True


def test_uvicorn_workers_multi():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"UVICORN_WORKERS": "2"}, clear=False):
        assert _is_multi_worker() is True


def test_uvicorn_workers_one_is_single():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"UVICORN_WORKERS": "1"}, clear=False):
        assert _is_multi_worker() is False


def test_bad_env_value_treated_as_single():
    from fastapi_visualizer.app import _is_multi_worker
    with patch.dict(os.environ, {"WEB_CONCURRENCY": "not-a-number"}, clear=False):
        assert _is_multi_worker() is False
```

- [ ] **Step 2: Run to confirm fail**

```bash
uv run pytest tests/test_multiworker.py -v
```

Expected: `ImportError` or `AttributeError` — `_is_multi_worker` not defined yet.

- [ ] **Step 3: Add `_is_multi_worker` and startup log to `app.py`**

Add `import os` at the top of `src/fastapi_visualizer/app.py` (after `import sys`).

Add this function after `_default_roots()`:

```python
def _is_multi_worker() -> bool:
    """True when env signals multiple worker processes (gunicorn WEB_CONCURRENCY
    or uvicorn UVICORN_WORKERS set to > 1). Fail-soft: bad values → False."""
    for key in ("WEB_CONCURRENCY", "UVICORN_WORKERS"):
        try:
            val = int(os.environ.get(key, "1"))
            if val > 1:
                return True
        except (ValueError, TypeError):
            pass
    return False
```

In `on_startup()` inside `visualize()`, add after the existing `try: loop = asyncio.get_running_loop()` block:

```python
        import logging
        _log = logging.getLogger(__name__)
        if _is_multi_worker():
            _log.warning(
                "fastapi-visualizer: running under multiple workers "
                "(PID %d) — dashboard shows only THIS worker's traffic. "
                "Run a single worker to see all requests.",
                __import__("os").getpid(),
            )
```

Place that block inside `on_startup`, wrapped in `try/except Exception: pass` (fail-soft):

```python
    async def on_startup() -> None:
        try:
            loop = asyncio.get_running_loop()
        except Exception:
            return
        try:
            loop.set_debug(True)
        except Exception:
            pass
        try:
            identity.install_task_factory(loop)
        except Exception:
            pass
        try:
            monitor.install()
        except Exception:
            pass
        try:
            task, stop_event = threadpool.start(loop)
            state["poll_task"] = task
            state["stop_event"] = stop_event
        except Exception:
            pass
        try:
            import logging
            if _is_multi_worker():
                logging.getLogger(__name__).warning(
                    "fastapi-visualizer: running under multiple workers "
                    "(PID %d) — dashboard shows only THIS worker's traffic. "
                    "Run a single worker to see all requests.",
                    os.getpid(),
                )
        except Exception:
            pass
```

- [ ] **Step 4: Run tests — expect pass**

```bash
uv run pytest tests/test_multiworker.py -v
```

Expected: all 6 pass.

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
uv run pytest -v
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/fastapi_visualizer/app.py tests/test_multiworker.py
git commit -m "feat(task9): add _is_multi_worker() detection + startup log"
```

---

## Task 2: Send `meta` in first WebSocket frame

**Files:**
- Modify: `src/fastapi_visualizer/app.py` — `ws_endpoint` inside `_mount_dashboard`
- Modify: `tests/test_multiworker.py` — add WS meta frame test

**Interfaces:**
- Consumes: `_is_multi_worker() -> bool` from Task 1
- Produces: first WS frame shape: `{"events": [...backlog...], "meta": {"worker_pid": int, "multi_worker": bool}}`

The first frame the dashboard receives is the backlog snapshot. We extend it with a `meta` key so the client knows worker context without a separate round-trip.

- [ ] **Step 1: Write failing test**

Add to `tests/test_multiworker.py`:

```python
import asyncio
import json
import pytest
from fastapi import FastAPI
from fastapi_visualizer import visualize


@pytest.mark.anyio
async def test_ws_first_frame_has_meta(client_for):
    """First WS frame must carry meta.worker_pid and meta.multi_worker."""
    import os
    from unittest.mock import patch

    app = FastAPI()

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    with patch.dict(os.environ, {"WEB_CONCURRENCY": "3"}):
        visualize(app)

    received = []

    async with app.router.lifespan_context(app):
        from starlette.testclient import TestClient
        with TestClient(app) as client:
            with client.websocket_connect("/_viz/ws") as ws:
                raw = ws.receive_text()
                received.append(json.loads(raw))

    assert received, "expected at least one WS frame"
    frame = received[0]
    assert "meta" in frame, f"meta missing from first frame: {frame.keys()}"
    assert "worker_pid" in frame["meta"]
    assert isinstance(frame["meta"]["worker_pid"], int)
    assert "multi_worker" in frame["meta"]
    assert frame["meta"]["multi_worker"] is True
```

- [ ] **Step 2: Run to confirm fail**

```bash
uv run pytest tests/test_multiworker.py::test_ws_first_frame_has_meta -v
```

Expected: FAIL — `meta` key missing from frame.

- [ ] **Step 3: Extend `ws_endpoint` to include `meta` in backlog frame**

In `src/fastapi_visualizer/app.py`, inside `_mount_dashboard`, change the backlog send:

```python
    async def ws_endpoint(websocket):
        # ... existing comments and accept() ...
        await websocket.accept()
        queue = collector.subscribe()

        async def wait_disconnect():
            try:
                while True:
                    msg = await websocket.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
            except Exception:
                return

        reader = asyncio.create_task(wait_disconnect())
        try:
            backlog = [e.to_dict() for e in collector.snapshot()]
            await websocket.send_json({
                "events": backlog,
                "meta": {
                    "worker_pid": os.getpid(),
                    "multi_worker": _is_multi_worker(),
                },
            })
            while not reader.done():
                # ... rest unchanged ...
```

Only the `send_json` call for the backlog changes — add the `"meta"` key. The rest of `ws_endpoint` is untouched.

- [ ] **Step 4: Run test — expect pass**

```bash
uv run pytest tests/test_multiworker.py -v
```

Expected: all pass.

- [ ] **Step 5: Full suite**

```bash
uv run pytest -v
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/fastapi_visualizer/app.py tests/test_multiworker.py
git commit -m "feat(task9): include meta (worker_pid, multi_worker) in first WS frame"
```

---

## Task 3: Dashboard banner — HTML + CSS

**Files:**
- Modify: `src/fastapi_visualizer/static/index.html`

**Interfaces:**
- Produces: `#multi-worker-warn` element (hidden by default), referenced by Task 4's JS

The banner follows the same pattern as the existing `#drop-warn` element — hidden until JS shows it.

- [ ] **Step 1: Add CSS for the banner**

In `src/fastapi_visualizer/static/index.html`, after the `#drop-warn` CSS rule (around line 73), add:

```css
  #multi-worker-warn {
    font-size: 12px;
    color: #d29922;
    font-family: monospace;
    background: rgba(210, 153, 34, 0.1);
    border: 1px solid rgba(210, 153, 34, 0.3);
    border-radius: 4px;
    padding: 2px 8px;
  }
```

- [ ] **Step 2: Add the banner element in the header**

In the `<header>` section, after the `#drop-warn` div (around line 157), add:

```html
  <div id="multi-worker-warn" hidden title="each worker has its own in-memory collector — connect to a single-worker process to see all traffic">⚠ worker <span id="worker-pid"></span> — showing only this worker's traffic · run single worker to see all requests</div>
```

- [ ] **Step 3: Verify HTML renders without errors**

```bash
uv run uvicorn examples.demo:app --port 8001
```

Open `http://127.0.0.1:8001/_viz/` in browser. Header must look identical to before (banner is hidden). Kill server.

- [ ] **Step 4: Commit**

```bash
git add src/fastapi_visualizer/static/index.html
git commit -m "feat(task9): add multi-worker warning banner element to dashboard HTML"
```

---

## Task 4: Dashboard JS — read meta, show banner

**Files:**
- Modify: `src/fastapi_visualizer/static/dashboard.js`

**Interfaces:**
- Consumes: `frame.meta.worker_pid: number`, `frame.meta.multi_worker: boolean` from Task 2
- Consumes: `#multi-worker-warn`, `#worker-pid` DOM elements from Task 3

On the first WS message (the backlog frame), if `frame.meta.multi_worker` is true, un-hide the banner and fill in the PID. The banner stays visible for the entire session (no need to hide it again — if you're multi-worker you stay multi-worker).

- [ ] **Step 1: Add element references near the top of the IIFE**

In `dashboard.js`, near where `dropWarnEl` and `dropCountEl` are assigned (around line 91), add:

```javascript
  var multiWorkerWarnEl = document.getElementById("multi-worker-warn");
  var workerPidEl = document.getElementById("worker-pid");
```

- [ ] **Step 2: Handle `frame.meta` in `ws.onmessage`**

In the `ws.onmessage` handler, inside the `!sawFirstFrame` branch (which currently just skips the backlog), add meta handling before the `return`:

```javascript
    ws.onmessage = function (msg) {
      try {
        var frame = JSON.parse(msg.data);
        if (!frame.events) return;
        if (!sawFirstFrame) {
          sawFirstFrame = true;
          // Apply meta from the first frame (worker context).
          try {
            var meta = frame.meta;
            if (meta && meta.multi_worker) {
              if (multiWorkerWarnEl) multiWorkerWarnEl.hidden = false;
              if (workerPidEl) workerPidEl.textContent = String(meta.worker_pid || "?");
            }
          } catch (e) { /* ignore */ }
          // Set live edge from backlog timestamps.
          for (var k = 0; k < frame.events.length; k++) {
            if (frame.events[k].t > connectBaselineT) connectBaselineT = frame.events[k].t;
          }
          return;
        }
        for (var s = 0; s < frame.events.length; s++) noteSeq(frame.events[s].seq);
        bufferEvents(frame.events);
      } catch (e) {
        /* ignore malformed frame */
      }
    };
```

This replaces the existing `ws.onmessage` block — copy it exactly from the current file and insert the `meta` block in the `!sawFirstFrame` branch.

- [ ] **Step 3: Smoke test manually**

```bash
WEB_CONCURRENCY=3 uv run uvicorn examples.demo:app --port 8001
```

Open `http://127.0.0.1:8001/_viz/`. The header must show the yellow banner:
`⚠ worker <PID> — showing only this worker's traffic · run single worker to see all requests`

Then run without the env var:

```bash
uv run uvicorn examples.demo:app --port 8001
```

Open `http://127.0.0.1:8001/_viz/`. The banner must NOT appear.

Kill the server.

- [ ] **Step 4: Full test suite**

```bash
uv run pytest -v
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/fastapi_visualizer/static/dashboard.js
git commit -m "feat(task9): show multi-worker banner in dashboard when meta.multi_worker is true"
```

---

## Task 5: Docs + changelog

**Files:**
- Modify: `docs/changelog.md`
- Modify: `docs/architecture.md` — Known limitations section

- [ ] **Step 1: Update changelog**

In `docs/changelog.md`, under `## [Unreleased]` → `### Added`, add:

```markdown
- **Multi-worker awareness** (Phase 3, plan task 9): when `WEB_CONCURRENCY` or
  `UVICORN_WORKERS` is > 1, the visualizer logs a startup warning and the
  dashboard shows a persistent banner: "⚠ worker PID — showing only this
  worker's traffic · run single worker to see all requests". The in-memory
  `Collector` is per-process, so each worker only sees its own traffic;
  the banner makes this limitation explicit rather than silently showing
  incomplete data.
```

- [ ] **Step 2: Update architecture.md known limitations**

In `docs/architecture.md`, under `## Known limitations`, the existing note about multi-worker is brief. Replace or extend it to:

```markdown
- **Multi-worker processes each have their own in-memory collector.**
  `uvicorn --workers N` or gunicorn forks N separate processes; `/_viz`
  is served by whichever worker handles that request, and the ring buffer
  is per-process. Traffic handled by other workers is invisible. The
  dashboard surfaces this with a banner when `WEB_CONCURRENCY` or
  `UVICORN_WORKERS` > 1. **Recommendation:** run a single worker
  (`uvicorn examples.demo:app`) during development; add workers for load
  testing only.
```

- [ ] **Step 3: Commit**

```bash
git add docs/changelog.md docs/architecture.md
git commit -m "docs(task9): document multi-worker limitation and banner"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered |
|---|---|
| Detect multi-worker via `WEB_CONCURRENCY` | ✅ Task 1 |
| Detect multi-worker via `UVICORN_WORKERS` | ✅ Task 1 |
| Startup log with PID | ✅ Task 1 |
| Dashboard banner with PID | ✅ Tasks 3+4 |
| "run single worker" message | ✅ Task 3 HTML |
| Single-worker shows no banner | ✅ Task 4 smoke test |
| `--workers 2` shows banner done-check | ✅ Task 4 smoke test (`WEB_CONCURRENCY=3`) |
| Document single-worker recommendation | ✅ Task 5 |

**Placeholder scan:** None found.

**Type consistency:** `_is_multi_worker() -> bool` defined in Task 1, used in Tasks 1 (test), 2 (ws frame), unchanged in Task 4 (reads `frame.meta.multi_worker` bool). Consistent.

**Note on `WEB_CONCURRENCY` vs actual `--workers`:** uvicorn's `--workers` flag does NOT automatically set `WEB_CONCURRENCY` — it's only set by gunicorn and PaaS platforms (Heroku, Railway). The smoke test therefore uses `WEB_CONCURRENCY=3` as an env var rather than `--workers 3`. The plan doc for Task 9 says "where feasible" — this is the feasible signal. A user running `uvicorn --workers 4` without `WEB_CONCURRENCY` won't see the banner; this is a known gap and documented.
