# fastapi-visualizer

A dev-time dashboard that shows what your app's event loop is actually
doing: which request currently holds the loop, which ones are parked at an
`await`, and which sync handlers are running on the threadpool — live, as a
flow-graph, in your browser.

Works with **FastAPI/Starlette** and **Django** (and any other ASGI app). The
tracing itself is framework-agnostic — it reads the interpreter, not the
framework — so only the way it attaches differs. See
[Using it with Django](#using-it-with-django).

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

## Quickstart (FastAPI)

```python
from fastapi import FastAPI
from fastapi_visualizer import visualize

app = FastAPI()

@app.get("/")
async def root():
    return {"ok": True}

visualize(app, enabled=True)
```

Run your app as usual and open `http://127.0.0.1:8000/_viz`:

```bash
uv run uvicorn your_module:app --reload
```

## Enabling it (important)

The visualizer is **off by default**. `visualize(app)` with no other signal
installs nothing at all — no monitoring, no task factory, no threadpool
poller, no `/_viz` mount — and prints one line telling you how to turn it on.
That is deliberate: it means you can leave the call in your app permanently
without it following you into production.

It turns itself on when any of these is true:

| how | when to use it |
|---|---|
| `visualize(app, enabled=True)` | explicit; always wins |
| `FASTAPI_VIZ=1` in the environment | per-shell / per-deploy toggle, no code change |
| `FastAPI(debug=True)` | you already run debug mode locally |

`enabled=False` forces it off even with the env flag set.

Being enabled also means `/_viz` is served **unauthenticated** — anyone who can
reach the port can see your paths and source structure. Bind to localhost or
keep it off any shared environment.

To try the **bundled demo** instead, run it from *this* repo:

```bash
uv run uvicorn examples.demo:app --reload
```

`examples/demo.py` has an async endpoint (`/async`, a nested async call chain
with real awaits), a sync one (`/sync`, nested sync calls that Starlette
offloads to the threadpool), and a `/blocking` one (an `async def` doing sync
work, which freezes the loop) to fire at. Drive a mix of all three with
`uv run python examples/drive.py`.

By default `visualize(app, roots=None)` traces only the source directory of
the module that called it (its own package directory is always excluded).
Pass `roots=[...]` to trace additional/different directories.

## Using it with Django

Three differences from FastAPI. Each one silently does nothing if you miss
it — no error, just an empty or misleading dashboard.

```python
# yourproject/asgi.py
import os
from django.core.asgi import get_asgi_application
from fastapi_visualizer import visualize

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "yourproject.settings")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

application = visualize(
    get_asgi_application(),
    enabled=True,          # required: see below
    roots=[BASE_DIR],      # required: see below
)
```

**1. You must assign the result.** `visualize()` attaches to a Starlette app by
mutating it, but a Django `ASGIHandler` has no `.add_middleware`, `.mount`,
`.state` or `.router` to attach to — so it returns a *wrapped* ASGI app
instead. `visualize(application)` without the assignment attaches nothing. It
prints a reminder when this happens.

**2. You must pass `roots`.** The default is the directory of the file that
called `visualize()`. In a Django project that is `yourproject/yourproject/`
(where `asgi.py` lives), and your apps are *siblings* of it — so the default
traces none of your code, and requests show up with no call tree. Point it at
the project root.

**3. `enabled=True` is required.** Auto-detection reads `app.debug`, which an
`ASGIHandler` does not have — so it stays off even with Django's own
`DEBUG = True`. Or export `FASTAPI_VIZ=1`.

Then run it under an ASGI server and open `http://127.0.0.1:8000/_viz`:

```bash
uvicorn yourproject.asgi:application --port 8000
```

**ASGI only.** `manage.py runserver` is WSGI — there is no event loop, so
there is nothing to visualise.

Sync Django views (`def`) run on a worker thread via `asgiref` and appear in
the THREADPOOL zone; `async def` views appear in the EVENT LOOP zone. A
request that offloads mid-flight (an `async` view awaiting `sync_to_async`)
moves to THREADPOOL while the offloaded call runs and returns when it
finishes.

There is a bundled demo at `examples/django_demo.py`.

## Dashboard controls

Drive traffic with your app as normal (real user actions, curl, httpx, a load
tool) — the dashboard reflects whatever requests hit the app.

- **speed** — slow-motion playback multiplier (0.05×–1.0×, default 0.2×),
  since real interleaving happens in milliseconds.
- **max req** — max rows kept on screen (default 10, 1–50); at the cap the
  oldest *finished* row is evicted to make room for a new live one.
- **slow req** — duration threshold in ms (default 500); requests slower than
  this get an amber outcome tag and match the `slow:true` filter.
- **filter** — hide rows that don't match. Space-separated terms, all of which
  must match: `path:/checkout`, `status:500`, `slow:true`,
  `zone:loop`/`zone:threadpool`. A bare word is a substring match on the path
  or the trace id. Display-only — it never changes what is recorded.
- **step** — pause playback; each "▶ step" click advances events until the
  loop hands off to a different request *or* a request finishes.
- **clear** — wipes every displayed row.

Each row is tagged with its runtime state and, once finished, its outcome —
`200 · 42ms`, amber past the slow threshold, red for a 5xx or an unhandled
exception.

**Click a row** to open the request **inspector** (bottom-right, under the
legend) and expand its
call tree at the same time. The inspector shows the full trace id (selectable,
for pasting into a log search), any inbound `X-Request-ID`, status, duration,
execution zone, asyncio task count, call-node count, suspension count, and
blocking spans.

Hover a node for its qualname, `file:line`, and await state — and to outline
**that same function in every other row**, which shows where a shared helper
is running across concurrent requests. Async requests appear in the top EVENT
LOOP zone (one glows = holds the loop), sync ones in the bottom THREADPOOL zone
(several run at once). If the server sheds events under load, a header banner
reports how many were dropped. The dashboard is **view-only** — it never calls
your app.

## Options

```python
visualize(
    app,
    roots=None,                  # dirs to trace; default = caller's directory
    slow_ms=100,                 # loop-blocking threshold (see below)
    enabled=None,                # None = auto (FASTAPI_VIZ=1 or app.debug)
    path="/_viz",                # where to mount the dashboard
    correlate_request_id=False,  # use an inbound X-Request-ID as the trace id
    expose_request_id=False,     # send the trace id back as x-request-id
)
```

### Changing the dashboard path

`path=` moves the whole dashboard — page, script and WebSocket — anywhere you
like, which is useful when `/_viz` collides with one of your own routes, or when
you want it behind a less guessable prefix:

```python
visualize(app, enabled=True, path="/debug/viz")
```

Then open `http://127.0.0.1:8000/debug/viz`. Leading and trailing slashes are
optional (`"debug/viz/"` works). `path="/"` raises `ValueError` — mounting at
the root would shadow your app's own routes.

You don't have to tell the frontend: `dashboard.js` derives its WebSocket URL
from its own `location.pathname`, so the page and its socket stay siblings under
whatever mount you chose. No rebuild, no config file.

An inbound `X-Request-ID` is always *recorded* and shown in the inspector, so a
dashboard row can be matched against an upstream log. It only *becomes* the
trace id when `correlate_request_id=True` — otherwise a client could choose its
own id. Correlated ids are filtered to `[A-Za-z0-9._-]` and truncated to 64
characters.

## Blocking detection

Sync or CPU work inside an `async def` — `time.sleep`, a tight loop, a blocking
driver call — freezes the single loop thread, so *every* other request stalls.
The dashboard flashes the EVENT LOOP spine red with
`🔥 BLOCKED by <qualname> (Ns)`, glows the offending node, and leaves a durable
`🔥 blocked` tag on that request's row so a finished request still records that
it froze the loop.

The threshold is `slow_ms` (default 100): an in-root frame that holds the loop
longer than this **without yielding** is reported. An `await` that takes a long
time is *not* blocking — yielding is exactly what it's supposed to do. Work on
a threadpool worker is never flagged either; that's what the threadpool is for.
Try it with the demo's `/blocking` endpoint.

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
client-side from the stream using the fact that a standard ASGI/uvicorn
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
  It is off by default for that reason — see *Enabling it* above.
- When enabled, `/_viz` and its WebSocket are **unauthenticated**. There is no
  token option yet, so don't enable it on anything reachable beyond localhost.
- `uvicorn --workers N` runs N processes, each with its own loop and its own
  in-memory buffer, so the dashboard only shows the worker that happened to
  serve `/_viz`. Run a single worker while using it.
- **On Django, the THREADPOOL worker-count reads `0/40` regardless of load.**
  The poller reads AnyIO's thread limiter and Django uses `asgiref`'s own
  executor, so no occupancy samples are produced. Rows still appear in the
  zone correctly; only the header count is wrong.
- If a virtualenv lives inside a traced root (`./venv`, `./.venv`), its
  contents are excluded automatically — `roots` means your source, and
  site-packages is never treated as app code.
