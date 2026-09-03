"""Django ASGI demo for fastapi-visualizer (experimental).

Deliberately a single file with `settings.configure()` rather than a generated
project, so the experiment stays readable and has no extra directories.

Run with:

    uv run uvicorn examples.django_demo:application --port 8200

Then open http://127.0.0.1:8200/_viz and drive traffic:

    uv run python examples/drive.py --base http://127.0.0.1:8200

Note the assignment: `visualize()` cannot mutate a Django ASGIHandler (no
.add_middleware/.mount/.state/.router to attach to), so it returns a wrapped
ASGI app and you must bind the result.
"""

import asyncio
import os
import sqlite3
import time

import django
from django.conf import settings

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

if not settings.configured:
    settings.configure(
        DEBUG=True,
        SECRET_KEY="fastapi-visualizer-demo-not-a-real-secret",
        ALLOWED_HOSTS=["*"],
        ROOT_URLCONF=__name__,
        INSTALLED_APPS=[],
        MIDDLEWARE=[],
        DATABASES={},
    )
    django.setup()

from asgiref.sync import sync_to_async  # noqa: E402
from django.http import JsonResponse  # noqa: E402  (must follow django.setup)
from django.urls import path as urlpath  # noqa: E402


# --- async chain: real awaits, interleaves on the loop ---------------------


async def db_fetch(user_id: int) -> dict:
    await asyncio.sleep(0.2)
    return {"id": user_id, "name": "ada"}


async def get_user(user_id: int) -> dict:
    return await db_fetch(user_id)


async def async_view(request):
    user = await get_user(1)
    return JsonResponse({"mode": "async", "user": user})


# --- sync chain: Django offloads this to a worker thread -------------------


def query_db() -> dict:
    time.sleep(0.2)
    return {"id": 1, "name": "ada"}


def load_user() -> dict:
    return query_db()


def sync_view(request):
    user = load_user()
    time.sleep(0.2)
    return JsonResponse({"mode": "sync", "user": user})


# --- async, but doing blocking work: freezes the loop ----------------------


async def blocking_view(request):
    # No await: this runs sync on the loop thread for 0.3s, stalling every
    # other request. Should trip blocking detection.
    time.sleep(0.3)
    return JsonResponse({"mode": "blocking"})


# --- an async view handing work to a worker ------------------------------
#
# The historically-broken case, kept as a demo because it was broken in an
# instructive way. An earlier version moved the whole row into THREADPOOL the
# moment any offload started, and never moved it back — so an async view that
# awaited one DB call appeared to spend its entire life on a worker thread.
#
# It does not: the coroutine stays parked ON THE LOOP and only the callable
# runs on a worker. The row belongs to the EVENT LOOP zone, and the offloaded
# call shows as its own separate entry in THREADPOOL while it runs.


async def offloaded_view(request):
    """Async view, correct offload. Row parks on the loop; a worker runs it."""
    user = await get_user(1)
    await sync_to_async(query_db)()
    return JsonResponse({"mode": "offloaded", "user": user})


# --- what Django's "async ORM" actually is -------------------------------
#
# `Wallet.objects.afirst()` is not native async. It is:
#
#     async def afirst(self):
#         return await sync_to_async(self.first)()
#
# ...and `sync_to_async` defaults to thread_sensitive=True, which pins every
# such call to ONE shared thread. So concurrent ORM calls do not run in
# parallel on a threadpool — they QUEUE on a single thread. Measured:
# 5 concurrent calls sleeping 0.2s each took 1022ms on one thread, against
# 216ms on five threads for FastAPI's run_in_threadpool.
#
# Written out longhand here because Django hides it: `afirst()`'s worker frame
# is Django's own code and therefore never traced, so the thread hop is
# invisible. Wrapping a sync call yourself puts YOUR frame on the worker,
# which is what makes it show up.


def sync_orm_query():
    """Stands in for `Wallet.objects.first()` — the sync ORM."""
    time.sleep(0.2)
    return {"id": 1, "name": "ada"}


async def orm_shape_view(request):
    """Exactly what afirst() does, written out so it is visible."""
    data = await sync_to_async(sync_orm_query)()  # thread_sensitive=True, as Django
    return JsonResponse({"mode": "orm-shape", "data": data})


async def orm_parallel_view(request):
    """The same call with the pin removed, for the side-by-side."""
    data = await sync_to_async(sync_orm_query, thread_sensitive=False)()
    return JsonResponse({"mode": "orm-parallel", "data": data})


async def orm_gather_view(request):
    """TWO ORM calls gathered in one view — and they do NOT overlap.

    This is the surprising one. `sync_to_async` defaults to
    thread_sensitive=True, and Django gives each REQUEST its own
    thread-sensitive worker. So concurrent requests do run in parallel, but two
    calls inside a single request queue behind each other on that one worker.

    Measured: 407ms for two 200ms calls on one thread, against 206ms on two
    threads once the pin is removed. `asyncio.gather` buys nothing here, which
    is not what the code looks like it does.
    """
    a, b = await asyncio.gather(
        sync_to_async(sync_orm_query)(),
        sync_to_async(sync_orm_query)(),
    )
    return JsonResponse({"mode": "orm-gather", "a": a, "b": b})


async def orm_gather_free_view(request):
    """The same gather with thread_sensitive=False: now they really overlap."""
    a, b = await asyncio.gather(
        sync_to_async(sync_orm_query, thread_sensitive=False)(),
        sync_to_async(sync_orm_query, thread_sensitive=False)(),
    )
    return JsonResponse({"mode": "orm-gather-free", "a": a, "b": b})


# --- the two cases the newer detectors exist for -------------------------


async def fast_db_view(request):
    """A ~1ms database connect on the loop thread.

    Too fast for any threshold, so only the audit-hook listener can see it.
    The point of having it here is to prove that detector works on Django and
    not just on FastAPI — it hooks the interpreter, not the framework.
    """
    con = sqlite3.connect(":memory:")
    con.execute("select 1").fetchone()
    con.close()
    return JsonResponse({"mode": "fast db"})


async def cpu_view(request):
    """0.3s of pure computation — waits on nothing at all.

    Draws the same row as /blocking, which is the point: the tool reports
    "held the loop" and refuses to guess a cause.
    """
    total = 0
    for i in range(9_000_000):
        total += i
    return JsonResponse({"mode": "cpu", "total": total})


async def root(request):
    return JsonResponse({"open": "/_viz"})


urlpatterns = [
    urlpath("", root),
    urlpath("async", async_view),
    urlpath("sync", sync_view),
    urlpath("blocking", blocking_view),
    urlpath("offloaded", offloaded_view),
    urlpath("orm_shape", orm_shape_view),
    urlpath("orm_parallel", orm_parallel_view),
    urlpath("orm_gather", orm_gather_view),
    urlpath("orm_gather_free", orm_gather_free_view),
    urlpath("fast_db", fast_db_view),
    urlpath("cpu", cpu_view),
]

from django.core.asgi import get_asgi_application  # noqa: E402

from fastapi_visualizer import visualize  # noqa: E402

# enabled=True is required here: auto-detection reads `app.debug`, which a
# Django ASGIHandler does not have, so it would otherwise resolve to OFF even
# with Django's own DEBUG=True.
application = visualize(
    get_asgi_application(),
    enabled=True,
    roots=[BASE_DIR],
)
