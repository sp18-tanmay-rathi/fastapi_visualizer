"""Demo app for fastapi-visualizer.

Run with:

    uv run uvicorn examples.demo:app

Then open http://127.0.0.1:8000/_viz in a browser and drive some traffic:

    uv run python examples/drive.py

to watch call-tree branches sprout off the event-loop spine, park at their
await points, and the sync endpoint run on the threadpool cluster.
"""

import asyncio
import time

from fastapi import FastAPI

from fastapi_visualizer import visualize

app = FastAPI()


async def db_fetch(user_id: int) -> dict:
    await asyncio.sleep(0.2)
    return {"id": user_id, "name": "ada"}


async def get_user(user_id: int) -> dict:
    return await db_fetch(user_id)


def serialize(user: dict) -> dict:
    return {"mode": "async", "user": user}


@app.get("/async")  # async: real await, interleaves on the loop
async def async_ep():
    user = await get_user(1)
    return serialize(user)


def query_db() -> dict:
    time.sleep(0.2)
    return {"id": 1, "name": "ada"}


def load_user() -> dict:
    return query_db()


@app.get("/sync")  # sync: offloaded to the 40-token threadpool
def sync_ep():
    user = load_user()
    time.sleep(0.2)
    return {"mode": "sync", "user": user}


@app.get("/")
async def root():
    return {"open": "/_viz"}


visualize(app)
