# Experiment: does this work with Django?

**Status: experimental — it works.** Lives on `experiment/django-support`, not
merged. This file records what was needed, what was verified, and the one real
gap.

## Short answer

Yes, with a new entry point. **No instrumentation changes were needed at all** —
the tracing core was already framework-agnostic. Only the *attachment* was
FastAPI-shaped.

## Why `visualize()` could not work

Everything Django-incompatible was four Starlette-specific calls in
`app.py::visualize()`:

| Call | Django equivalent |
|---|---|
| `app.add_middleware(TraceMiddleware, ...)` | none — `ASGIHandler` has no middleware registry |
| `app.mount(path, viz_app)` | none — no router to mount onto |
| `app.state._viz = ...` | none — no `.state` |
| `app.router.lifespan_context` | none — Django does not implement lifespan |

Everything underneath was already portable: `monitor.py` is pure
`sys.monitoring`, `TraceMiddleware` is **already** a pure-ASGI middleware (it was
written that way to avoid `BaseHTTPMiddleware`'s contextvar bug), and
`collector.py` / `events.py` know nothing about the web layer.

## What was added

`src/fastapi_visualizer/asgi.py` — `visualize_asgi(app, ...)`, which returns a
wrapper ASGI app instead of mutating one:

```python
application = visualize_asgi(get_asgi_application(), enabled=True)
```

It composes in plain ASGI: owns the `lifespan` scope (install/uninstall the
monitor), serves the dashboard for any path under `path`, and passes everything
else to the wrapped app through `TraceMiddleware`.

`app.py` needed one small refactor: `_mount_dashboard()` was split so the
dashboard sub-app is built by a reusable `build_viz_app()`, which the wrapper
serves directly rather than mounting.

`examples/django_demo.py` — a single-file Django ASGI app (`settings.configure()`,
no generated project) with an async view, a sync view, and a blocking view.

## Verified against a live Django server

`uvicorn examples.django_demo:application --port 8200`, 7 concurrent requests
(3 async, 3 sync, 1 blocking), observed over the real WebSocket:

| Check | Result |
|---|---|
| Request lifecycle | 7 `request_start` / 7 `request_end` |
| Status + duration | all `200`, 312–421 ms |
| Call tree | 19 `call_enter`, 12 with a resolvable parent — real nesting |
| Traced functions | `async_view, blocking_view, db_fetch, get_user, load_user, query_db, sync_view` |
| Zone classification | `event_loop: 4`, `threadpool: 3` — exactly right |
| Offload attribution | 3 `offload_start` / `offload_end` pairs |
| Blocking detection | `blocking_view` flagged at 305 ms |
| suspend / resume | 9 / 9, balanced |
| Stream integrity | 0 seq gaps |
| Dashboard + WebSocket | served at `/_viz`, streams normally |

Worth calling out: **offload detection works unchanged.** Django runs sync views
on a worker thread through `asgiref`, where `asyncio.current_task()` is `None` —
the exact signal `monitor.py` already keys off (task 6). Nothing Django-specific
was needed for the two-zone split.

## The one real gap: the threadpool worker grid

`pool_sample` events: **zero**.

`threadpool.py` polls AnyIO's default thread limiter. Django does not use AnyIO
— it uses `asgiref`'s own executor — so the limiter sits at 0 borrowed forever,
and since the poller only emits on change it emits nothing at all. The
THREADPOOL zone still fills with rows (that comes from `monitor.py`), but its
header reads `0/40 busy` regardless of load.

Options, if this graduates from an experiment:

- Read `asgiref`'s executor instead when it is in use — but that means private
  attributes (`SyncToAsync.executor._threads`, `_work_queue`), which is fragile.
- Make the poller pluggable and pick a reader by what is importable.
- Cheapest and most honest: when no `pool_sample` has ever arrived, render the
  grid as `—` / "not available" instead of a misleading `0/40`.

The last one is worth doing regardless — it is the same "never look more certain
than the instrumentation is" principle as the UNTRACED state.

## Other caveats

- **`enabled` auto-detection does not work.** It reads `app.debug`, which an
  `ASGIHandler` has no notion of, so a Django app resolves to OFF even with
  Django's own `DEBUG=True`. You must pass `enabled=True` or export
  `FASTAPI_VIZ=1`. Could be improved by also checking
  `django.conf.settings.DEBUG` when Django is importable.
- **Lifespan is not forwarded** to the wrapped app. Django does not implement it,
  so this is correct there — but it means `visualize_asgi()` is *not* a drop-in
  for a Starlette/FastAPI app, whose own startup handlers would be skipped.
  FastAPI users should keep using `visualize()`. If the wrapper ever becomes the
  single entry point, it needs proper lifespan proxying.
- **ASGI only.** Under WSGI there is no event loop, so there is nothing to
  visualize. `get_asgi_application()` and an ASGI server are required.
- **Starlette is still imported** for the dashboard routes, so a Django user
  pulls it in transitively. Acceptable for a dev tool; removable by hand-rolling
  the three routes in raw ASGI if it ever matters.

## Tests

`tests/test_asgi_wrapper.py` — 7 cases: disabled returns the original app
untouched, a hand-written ASGI app is traced, the dashboard is served under the
mount (default and custom path), and three Django cases (async view on the loop,
sync view offloaded, outcome recorded). Django is an optional dev dependency and
those cases `importorskip`.

`pyproject.toml` gained `pythonpath = ["."]` so tests can import
`examples.django_demo`.

Full suite: 60 passing.

## If we want to keep it

1. Fix the pool grid to show "not available" rather than `0/40`.
2. Teach `_resolve_enabled` about `django.conf.settings.DEBUG`.
3. Decide whether `visualize_asgi()` is the public entry point for everything
   non-FastAPI, or whether `visualize()` should detect and delegate.
4. README section + rename honesty: the package is called
   `fastapi-visualizer` but the core is really an *ASGI* visualizer.
