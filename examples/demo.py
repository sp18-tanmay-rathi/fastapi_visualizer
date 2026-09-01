"""Demo app for fastapi-visualizer — one endpoint per thing it detects.

Run with:

    uv run uvicorn examples.demo:app

Then open http://127.0.0.1:8000/_viz in a browser and drive some traffic:

    uv run python examples/drive.py

to watch call-tree branches sprout off the event-loop spine, park at their
await points, and the sync endpoint run on the threadpool cluster.

The endpoints below are grouped by what they are meant to show. Three
detectors answer different questions, and none of them covers everything:

    timer     did a frame hold the loop longer than `slow_ms`?
              (only knowable once that frame ENDS)
    watchdog  is the loop unresponsive right now?
              (fires above `stall_ms`, and is the only one that can report a
              request that never returns)
    listener  did the loop touch a file, socket, DNS, database or process?
              (categorical, so it catches a 1ms call no timer would flag)
"""

import asyncio
import sqlite3
import time

from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool

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


@app.get("/blocking")  # async, but does BLOCKING sync work -> freezes the loop
async def blocking_ep():
    # No `await`: this coroutine runs sync on the loop thread for 0.3s, so
    # every other request is stalled the whole time.
    # -> timer + watchdog. Row reads "⚙ held the loop 0.30s".
    time.sleep(0.3)
    return {"mode": "blocking"}


@app.get("/cpu")
async def cpu_ep():
    """The counter-case to `/blocking`: 0.3s of pure computation.

    It waits on nothing at all, yet the row is identical — "⚙ held the loop".
    That is the honest answer, not a gap: the timer knows a frame ran long, not
    why. No audit event fired is NOT proof of computation — `time.sleep` raises
    none either — so calling this one "CPU-bound" would mislabel the most common
    blocking call there is. The inspector says the cause is unknown and lists
    the frames.
    """
    total = 0
    for i in range(9_000_000):
        total += i
    return {"mode": "cpu", "total": total}


# --- the right way to call blocking code from async -----------------------


@app.get("/offloaded")
async def offloaded_ep():
    """Hands the blocking call to a worker thread.

    The request PARKS on the loop (WAITING · worker) — its coroutine is
    suspended, exactly as for any other await, and the loop stays free. The
    call itself appears in the THREADPOOL zone until it returns. Nothing here
    is reported as a problem.
    """
    user = await get_user(1)
    await run_in_threadpool(query_db)
    return serialize(user)


# --- too fast for any timer, caught by what it IS -------------------------


@app.get("/fast_db")
async def fast_db_ep():
    """A ~1ms database connect on the loop thread.

    -> 🔥 blocking I/O: database

    Caveat worth knowing: this opens a NEW connection every request, which is
    what makes it visible. Real apps pool connections, so the queries that
    follow raise no audit event and go unreported. See
    docs/plans/blocking-detection-v2.md.
    """
    con = sqlite3.connect(":memory:")
    con.execute("select 1").fetchone()
    con.close()
    return {"mode": "fast db"}


@app.get("/")
async def root():
    return {"open": "/_viz"}


# enabled=True: since task 7 the visualizer installs nothing unless app.debug
# is set or FASTAPI_VIZ=1 is exported. The demo opts in explicitly so it works
# straight from `uv run uvicorn examples.demo:app`.
visualize(app, enabled=True)
