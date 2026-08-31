"""Django ASGI demo for fastapi-visualizer (experimental).

Deliberately a single file with `settings.configure()` rather than a generated
project, so the experiment stays readable and has no extra directories.

Run with:

    uv run uvicorn examples.django_demo:application --port 8200

Then open http://127.0.0.1:8200/_viz and drive traffic:

    uv run python examples/drive.py --base http://127.0.0.1:8200

Django needs `visualize_asgi()`, not `visualize()`: a Django ASGIHandler is a
plain callable with no .add_middleware/.mount/.state/.router, so there is
nothing to attach to. The wrapper composes in plain ASGI instead.
"""

import asyncio
import os
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


async def root(request):
    return JsonResponse({"open": "/_viz"})


urlpatterns = [
    urlpath("", root),
    urlpath("async", async_view),
    urlpath("sync", sync_view),
    urlpath("blocking", blocking_view),
]

from django.core.asgi import get_asgi_application  # noqa: E402

from fastapi_visualizer import visualize_asgi  # noqa: E402

# enabled=True is required here: auto-detection reads `app.debug`, which a
# Django ASGIHandler does not have, so it would otherwise resolve to OFF even
# with Django's own DEBUG=True.
application = visualize_asgi(
    get_asgi_application(),
    enabled=True,
    roots=[BASE_DIR],
)
