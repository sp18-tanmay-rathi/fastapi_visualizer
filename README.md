# fastapi-visualizer

A dev-time dashboard that shows what your FastAPI app's event loop is
actually doing: which request currently holds the loop, which ones are
parked at an `await`, and which sync endpoints are running on the
threadpool — live, as a flow-graph, in your browser.

## Install

Python 3.12+ (required — the instrumentation uses `sys.monitoring`, PEP 669,
which landed in 3.12). Managed with [uv](https://docs.astral.sh/uv/):

```bash
uv add fastapi-visualizer
```

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

Run it and open the dashboard:

```bash
uv run uvicorn examples.demo:app --reload
```

then visit `http://127.0.0.1:8000/_viz`. The bundled `examples/demo.py` has
an async endpoint (`/async`, a nested async call chain with real awaits) and
a sync one (`/sync`, nested sync calls that Starlette offloads to the
threadpool) to fire at.

By default `visualize(app, roots=None)` traces only the source directory of
the module that called it (its own package directory is always excluded).
Pass `roots=[...]` to trace additional/different directories.

## Dashboard controls

- **load path / count / fire** — fires N concurrent plain GETs at a path,
  same-origin, no auth header — useful for self-demoing without external
  tooling. Auth-protected routes need an external driver (curl/httpx/etc.).
- **speed** — slow-motion playback multiplier (0.05×–1.0×, default 0.2×),
  since real interleaving happens in milliseconds.
- **max req** — max rows kept on screen (default 10, 1–50); at the cap the
  oldest *finished* row is evicted to make room for a new live one.
- **step** — pause playback; each "▶ step" click advances events until the
  loop hands off to a different request, one control transfer at a time.
- **clear** — wipes every displayed row.

Click a row to expand/collapse its full call tree (collapsed by default to
the active call path). Hover a node for its qualname, file:line, and await
state.

## How it works

Python 3.12's `sys.monitoring` fires real events at function
call/return/await-yield/await-resume boundaries. This project installs a
single global monitor, self-pruning by filename: code outside your traced
source directories is told to stop reporting after its first call (cheap),
while code inside your app builds a nested call tree per request, tagged with
suspend/resume events at each `await`. A background poller reports AnyIO
threadpool saturation for sync `def` endpoints.

Those events stream over a WebSocket to a canvas-based single-page app that
draws the event loop as a vertical spine with one row per request. "Who
currently holds the loop" isn't a directly measured event — it's derived
client-side from the stream using the fact that a standard FastAPI/uvicorn
process has exactly one event loop thread: whichever request most recently
entered or resumed a frame and hasn't since suspended is the one running.

See `docs/architecture.md` for the full design.

## Known limitations

- Only your app's own source is traced; time spent inside stdlib,
  site-packages, or the loop's own internals produces no events, so the
  loop-holder highlight can't see what happens there — it holds on the last
  known state until the next in-root event.
- The loop-holder highlight tracks the dashboard's slow-motion playback
  position, not wall-clock time.
- Threadpool offload attribution (which request is running on which worker)
  is best-effort: `asyncio.current_task()` is `None` on a plain worker
  thread, so there's no per-task stack to key off of there.
- This is a dev tool, not built for production traffic volumes: every
  tracing path is fail-soft (never breaks a request on error), but it still
  adds overhead proportional to how much of your app is in the traced roots.
