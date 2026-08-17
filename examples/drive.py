"""Fire concurrent traffic at the demo app so the /_viz dashboard populates.

The dashboard is view-only (it never calls the app itself), so you drive
traffic from outside. This is that driver for the bundled demo.

Usage — first run the demo in one terminal:

    uv run uvicorn examples.demo:app

then, in another terminal:

    uv run python examples/drive.py              # 5 async + 5 sync, one wave
    uv run python examples/drive.py --path /async --count 10
    uv run python examples/drive.py --waves 5 --delay 1.0

Open http://127.0.0.1:8000/_viz (set the speed slider low, ~0.1x) to watch the
async requests interleave on the event-loop spine while the sync ones run on
the threadpool.
"""

from __future__ import annotations

import argparse
import asyncio

import httpx


async def _wave(client: httpx.AsyncClient, paths: list[str]) -> None:
    results = await asyncio.gather(
        *(client.get(p) for p in paths), return_exceptions=True
    )
    ok = sum(1 for r in results if not isinstance(r, Exception) and r.status_code == 200)
    print(f"  wave: {ok}/{len(paths)} ok")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8000", help="app base URL")
    parser.add_argument(
        "--path",
        default=None,
        help="single path to hit (default: mix of /async and /sync)",
    )
    parser.add_argument("--count", type=int, default=5, help="concurrent requests per path")
    parser.add_argument("--waves", type=int, default=1, help="number of waves")
    parser.add_argument("--delay", type=float, default=1.0, help="seconds between waves")
    args = parser.parse_args()

    if args.path:
        paths = [args.path] * args.count
    else:
        paths = ["/async"] * args.count + ["/sync"] * args.count

    async with httpx.AsyncClient(base_url=args.base, timeout=30) as client:
        for i in range(args.waves):
            print(f"wave {i + 1}/{args.waves} -> {len(paths)} requests")
            await _wave(client, paths)
            if i < args.waves - 1:
                await asyncio.sleep(args.delay)


if __name__ == "__main__":
    asyncio.run(main())
