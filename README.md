# fastapi-visualizer

A dev-time dashboard that shows what your FastAPI app's event loop is
actually doing: which request currently holds the loop, which ones are
parked at an `await`, and which sync endpoints are running on the
threadpool — live, as a flow-graph, in your browser.

It splits into two zones: an **EVENT LOOP** zone where async requests take
turns one at a time, and a **THREADPOOL** zone where sync endpoints run on
worker threads in real parallel. Each request is tagged with its runtime
state — RUNNING, WAITING (at an `await`), UNTRACED (the loop is off in
library code the tool can't see), or DONE.

## Install

Python 3.12+ (required — the instrumentation uses `sys.monitoring`, PEP 669,
which landed in 3.12). Managed with [uv](https://docs.astral.sh/uv/).

**Not on PyPI yet** — so `uv add` works, but point it at the local path (or
git), not a bare name. A bare `uv add fastapi-visualizer` fails (nothing to
resolve).

**Recommended — path dependency** (persists across `uv sync`):

```bash
cd your-project
uv add --editable /Users/tanmayrathi/code-v2/fastapi_visualizer
```

This writes it into your project's `pyproject.toml`, so `uv sync` / `uv
remove` won't prune it. (A `uv pip install -e <path>` is *untracked* and gets
pruned on the next sync — avoid it.) Drop `--editable` if you don't want live
edits to the tool to flow through.

Alternatives:

- **From git** (once pushed):
  `uv add "git+https://github.com/tanmayrathi-sp18/fastapi_visualizer"`
- **PyPI** (only if/when published): then `uv add fastapi-visualizer` works
  as-is.

## Quickstart

```python
from fastapi import FastAPI
from fastapi_visualizer import visualize

app = FastAPI()

@app.get("/")
async def root():
    return {"ok": True}

visualize(app)
```

Run your app as usual and open `http://127.0.0.1:8000/_viz`:

```bash
uv run uvicorn your_module:app --reload
```

To try the **bundled demo** instead, run it from *this* repo:

```bash
uv run uvicorn examples.demo:app --reload
```

`examples/demo.py` has an async endpoint (`/async`, a nested async call chain
with real awaits) and a sync one (`/sync`, nested sync calls that Starlette
offloads to the threadpool) to fire at.

By default `visualize(app, roots=None)` traces only the source directory of
the module that called it (its own package directory is always excluded).
Pass `roots=[...]` to trace additional/different directories.

## Dashboard controls

Drive traffic with your app as normal (real user actions, curl, httpx, a load
tool) — the dashboard reflects whatever requests hit the app.

- **speed** — slow-motion playback multiplier (0.05×–1.0×, default 0.2×),
  since real interleaving happens in milliseconds.
- **max req** — max rows kept on screen (default 10, 1–50); at the cap the
  oldest *finished* row is evicted to make room for a new live one.
- **step** — pause playback; each "▶ step" click advances events until the
  loop hands off to a different request, one control transfer at a time.
- **clear** — wipes every displayed row.

Click a row to expand/collapse its full call tree (collapsed by default to
the active call path). Hover a node for its qualname, file:line, and await
state. Async requests appear in the top EVENT LOOP zone (one glows = holds
the loop), sync ones in the bottom THREADPOOL zone (several run at once). If
the server sheds events under load, a header banner reports how many were
dropped. The dashboard is **view-only** — it never calls your app.

## How it works

Python 3.12's `sys.monitoring` fires real events at function
call/return/await-yield/await-resume boundaries. This project installs a
single global monitor, self-pruning by filename: code outside your traced
source directories is told to stop reporting after its first call (cheap),
while code inside your app builds a nested call tree per request, tagged with
suspend/resume events at each `await`. Each request-root frame is classified
async (runs on the loop — including `async def … yield` dependencies) or
offloaded (runs with no asyncio task, i.e. a sync `def` on a worker thread);
that split drives the two zones. A background poller reports AnyIO threadpool
saturation.

Those events stream over a WebSocket to a canvas-based single-page app. "Who
currently holds the loop" isn't a directly measured event — it's derived
client-side from the stream using the fact that a standard FastAPI/uvicorn
process has exactly one event loop thread: whichever async request most
recently entered or resumed a frame and hasn't since suspended is the one
running. Because the tool only sees your own source, the loop can vanish into
library code between events — when that happens the holder is marked UNTRACED
rather than pretending it's still running.

See `docs/architecture.md` for the full design.

## Known limitations

- Only your app's own source is traced; time spent inside stdlib,
  site-packages, or the loop's own internals produces no events. The tool
  surfaces this rather than hiding it — a loop holder that goes quiet is
  marked UNTRACED instead of appearing to still run.
- The loop-holder highlight tracks the dashboard's slow-motion playback
  position, not wall-clock time.
- Buffers are bounded, so a busy app can drop events; dropping isn't silent
  (a `seq` gap raises a banner), but a trace spanning a drop may render
  incompletely.
- Threadpool offload attribution (which request is running on which worker)
  is best-effort: `asyncio.current_task()` is `None` on a plain worker
  thread, so there's no per-task stack to key off of there.
- This is a dev tool, not built for production traffic volumes: every
  tracing path is fail-soft (never breaks a request on error), but it still
  adds overhead proportional to how much of your app is in the traced roots.
