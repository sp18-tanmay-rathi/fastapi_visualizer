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

visualize(app, enabled=True)
```

Run your app as usual and open `http://127.0.0.1:8000/_viz`:

```bash
uv run uvicorn your_module:app --reload
```

### Enabling it (important)

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
    slow_ms=100,                 # "held the loop too long" threshold
    stall_ms=250,                # "loop is stuck right now" threshold; 0 disables
    detect_blocking_calls=True,  # report forbidden waits at any speed
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

Code that **waits** on the loop thread — `time.sleep`, a file read, a blocking
driver call — freezes the single thread, so every other request stalls behind
it. Code that **computes** for a long time holds it too, but that may be
deliberate. The tool distinguishes them.

Three detectors answer three different questions. Each catches something the
others cannot, so all three run:

| detector | question | catches |
|---|---|---|
| **timer** | did a frame hold the loop longer than `slow_ms`? | long holds — and it is the only one that sees a library which never releases the GIL |
| **watchdog** | is the loop unresponsive *right now*? | freezes as they happen, with the stack, plus a request that **never returns** |
| **listener** | did the loop touch a file, socket, DNS, database or process? | forbidden waits at **any** speed, including a 1ms call |

### What you see

| on the row | meaning |
|---|---|
| `⏱ STALLED` | the loop is frozen inside this request *right now* |
| `🔥 blocking I/O: file` | it waited on the outside world — a bug at any speed |
| `⚙ held the loop 1.01s ×2` | it ran long, cause unknown — click the row for the frames |

`⚙` is deliberately **not** labelled "CPU-bound". No detected wait is not proof
of computation: `time.sleep` raises no audit event and leaves no Python frame,
so claiming a cause there would mislabel the most common blocking call of all.
The inspector says plainly that the cause is unknown.

### Thresholds

`slow_ms` (default 100) is the timer's: a frame holding the loop longer than
this **without yielding** is reported once it ends. `stall_ms` (default 250) is
the watchdog's, and answers a different question — "is it stuck?" rather than
"was that slow?" — so it wants a larger number. Set `stall_ms=0` to turn the
watchdog off. Keep it well above its 50ms heartbeat or a healthy loop will trip
it.

An `await` never trips any of them, however long it takes: yielding is exactly
what it is supposed to do, and the loop stays free. Work on a threadpool worker
is never flagged either — that is what the threadpool is for.

### Two limits worth knowing

**The watchdog cannot reach your browser during a freeze.** The WebSocket send
runs on the very loop that is stuck. It writes the stall and its stack to the
**log** immediately instead, which is where you would be looking when a server
hangs; the dashboard catches up once the loop recovers.

**The listener cannot see pooled database queries.** Python announces that a
connection was *opened*, not that a query was *sent*. Real apps open once and
reuse, so the queries that follow raise no event. It still catches files,
subprocesses, DNS and the first connect. `detect_blocking_calls=False` turns it
off; it costs roughly 20% of throughput because Python announces these events
for every library in the process.

### Try it

`examples/demo.py` has one endpoint per case, and no two that show the same
thing:

| endpoint | shows |
|---|---|
| `/async` | a clean async request — awaits, never holds the loop |
| `/sync` | a `def` endpoint, run on a threadpool worker |
| `/offloaded` | the **correct** way to call blocking code from async: the request parks, a worker runs the call |
| `/blocking` | sync work inside `async def` → `⚙ held the loop` |
| `/cpu` | pure computation, waiting on nothing — an **identical** row, because the timer knows a frame ran long, not why |
| `/fast_db` | a ~1ms DB connect on the loop → `🔥 blocking I/O: database`, which no threshold could ever catch |

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
  It is off by default for that reason — see *Enabling it* above.
- When enabled, `/_viz` and its WebSocket are **unauthenticated**. There is no
  token option yet, so don't enable it on anything reachable beyond localhost.
- `uvicorn --workers N` runs N processes, each with its own loop and its own
  in-memory buffer, so the dashboard only shows the worker that happened to
  serve `/_viz`. Run a single worker while using it.
