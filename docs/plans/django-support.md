# Experiment: does this work with Django?

**Status: experimental, and it works.** Lives on
`experiment/django-support-v2`, branched from `main` after the dashboard
redesign merged. Not merged, and not a requirement — this is a proof of
concept, kept because the answer turned out to be interesting.

## Short answer

Yes, through the same `visualize()` call, and **no instrumentation changed at
all**. That was the finding worth having: the tracing core was already
framework-agnostic, and only the *attachment* was FastAPI-shaped.

Measured on `main` today, before any Django work:

| module | lines | `fastapi`/`starlette` imports |
|---|---|---|
| `monitor.py` | 520 | **0** |
| `watchdog.py` | 308 | **0** |
| `blockingcalls.py` | 295 | **0** |
| `identity.py` | 218 | **0** |
| `collector.py` | 102 | **0** |
| `threadpool.py` | 62 | **0** |
| `events.py` | 55 | **0** |
| `app.py` | 411 | 4 |

1,565 of 1,976 lines never mention a web framework. That is why a **replica
package for Django was rejected**: it would have duplicated the subtlest code
in the project — the `sys.monitoring` callbacks, the attribution snapshot, the
audit hook — and every bug fixed in one would have to be found and fixed again
in the other, forever.

## Why `visualize()` could not work unchanged

Everything Django-incompatible was Starlette-specific calls in `visualize()`:

| Call | Django equivalent |
|---|---|
| `app.add_middleware(TraceMiddleware, ...)` | none — `ASGIHandler` has no middleware registry |
| `app.mount(path, viz_app)` | none — no router to mount into |
| `app.state._viz = state` | none — no `.state` |
| `app.router.lifespan_context` | none — `ASGIHandler` does not implement lifespan |

## The two strategies

`visualize()` now detects what the app can do and returns the app to use:

| App | Strategy | Returns |
|---|---|---|
| Starlette / FastAPI | mutate in place | the **same** object |
| Django / any other ASGI app | wrap (`asgi.py`) | a **new** object — must be bound |

Mutating is kept for Starlette **deliberately, not for backwards
compatibility**: wrapping its `lifespan_context` still runs the app's own
startup handlers. The wrap strategy owns lifespan and cannot forward it, so
wrapping a Starlette app would silently skip its startup — database pools,
caches. `visualize()` returns the app on every path, so `app = visualize(app)`
is correct for both, and existing FastAPI callers that ignore the return keep
working.

## Using it with Django

```python
# yourproject/asgi.py
import os
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "yourproject.settings")

from fastapi_visualizer import visualize

application = visualize(
    get_asgi_application(),
    enabled=True,                                        # required, see below
    roots=[os.path.dirname(os.path.dirname(__file__))],  # your source tree
)
```

Three things that will bite otherwise:

**`application = ` is not optional.** Without it nothing is attached, and you
get no dashboard and no error. A line is printed on that path as a hint.

**`enabled=True` is required.** Auto-detection reads `app.debug`, which
`ASGIHandler` does not have, so it resolves to OFF even with Django's own
`DEBUG = True`. `FASTAPI_VIZ=1` works too.

**ASGI, not WSGI.** `manage.py runserver` is WSGI — there is no event loop, so
there is nothing to visualise. You need `get_asgi_application()` and an ASGI
server.

## What was verified

Run: `uv run uvicorn examples.django_demo:application --port 8200`

All three detectors work on Django, unchanged, and blame the right Django view:

```
endpoint        took  detectors fired    evidence
/async         203ms  -                  clean
/sync          407ms  -                  clean
/blocking      309ms  timer, watchdog    held blocking_view 305ms
/cpu           281ms  timer, watchdog    held cpu_view 279ms
/fast_db         4ms  listener           io:database
```

The watchdog also logs from its own thread, as on FastAPI:

```
event loop stalled 302ms and is still stuck, in blocking_view
```

The audit-hook listener working is the least obvious of the three and the most
reassuring: it hooks the **interpreter**, not the framework, so a 4ms database
call in a Django view is caught for exactly the same reason it is in FastAPI.

Sync views are classified correctly too — 6 concurrent `/sync` requests
produced 6 request-root frames tagged `threadpool` and 6 `offload_start`
events, so rows land in the right zone. Django dispatches them through
`asgiref`, where there is no current asyncio task: the same signal the FastAPI
path already keys off.

Covered by `tests/test_asgi_wrapper.py` (15 cases, `importorskip` so Django
stays an optional dev dependency).

## The one real gap

**AnyIO's capacity limiter never moves on Django.** `threadpool.py` polls it
for worker occupancy, but Django uses `asgiref`'s own executor, so no
`pool_sample` ever reports `borrowed > 0`. Verified: 6 concurrent sync views,
one baseline sample at `borrowed: 0`, and nothing after.

This used to mean the worker gauge read `0/40` forever. It no longer does —
**by accident.** The dashboard was changed (for an unrelated FastAPI reason:
the sampler runs on the loop and can be starved) to show
`max(sampled, observed)`, where *observed* is the live offload count derived
from `offload_start`/`offload_end`. Those events **do** fire on Django, so the
gauge works through the fallback path.

That is a fragile piece of luck, so it is pinned by a test:
`test_django_offloads_are_observable_even_without_pool_samples`. If a future
change makes the header trust the sampler alone, Django's gauge silently reads
zero again and that test fails.

A proper fix would read `asgiref`'s executor directly. Not done — it is
framework-specific plumbing for a POC.

## Other rough edges

- **`roots` needs care.** The default is the directory of the module that
  called `visualize()`, which for Django is the settings package — it does not
  cover sibling apps. Point it at the project root.
- **The package is named `fastapi_visualizer`** while handling Django. Fine for
  a POC; a rename is a separate conversation if this ever became real.
- **`fastapi` is still a runtime dependency** even though only `starlette` is
  imported, so a Django project pulls FastAPI in for nothing. One-line fix,
  not done.
- **Multi-worker** is unchanged: each process has its own collector, so run a
  single worker.

## Decision record

The alternative considered was a **replica package** (`django_visualizer`
beside `fastapi_visualizer`). Rejected on the numbers above: ~1,565 lines of
framework-agnostic code would have been duplicated, along with the entire
3,500-line frontend, which consumes events and has never known what framework
produced them.

Continuing the **original POC branch** was also rejected: `main` had moved 8
commits and +5,859/−1,728 ahead of it, and three of its five commits had been
superseded there independently. Its genuinely unique content was ~200 lines —
`asgi.py` and the two-strategy `visualize()` — so those were re-applied to a
fresh branch instead of rebasing conflicts in code that had since been
rewritten.
