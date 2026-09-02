# Catching blocked requests properly

**Status:** steps 0, 1, 2 and 3 are **done** — built, tested, documented, and
staged (not committed). Step 4 is not started and probably never should be on by
default. Every open question at the bottom of this file has been answered; they
are kept with their answers. None of this was needed for `v0.1.0`.

Measured against `examples/demo.py`, one endpoint per case:

```
endpoint       took  detectors that fired     verdict shown
/async        202ms  -                        clean
/sync         409ms  -                        clean
/offloaded    407ms  -                        clean
/fast_db        2ms  listener                 🔥 blocking I/O: database
/blocking     304ms  timer, watchdog          ⚙ held the loop 304ms ×1
/cpu          273ms  timer                    ⚙ held the loop 272ms ×1
```

`/fast_db` is the case that used to be completely invisible — too fast for any
threshold to see, and a real bug regardless of its duration. `/offloaded` is the
control: the same blocking call, correctly pushed to a worker, and correctly
reported as clean.

`/cpu` is the counter-case to `/blocking`: pure computation, waiting on nothing,
and an **identical** row. That is the point — the timer knows a frame ran long,
not why, which is exactly why the verdict stops at "held the loop". Note it
tripped the timer but not the watchdog here: at 273ms it sits on the 250ms
`stall_ms` line, so whether the watchdog also fires is a coin toss at that
duration.

The demo deliberately carries **one endpoint per verdict** and no duplicates.
Two behaviours therefore have no endpoint of their own and are covered by tests
instead: span accumulation (a request that blocks twice reports the sum over two
spans, not the larger one) and blame attribution (a blocking call several frames
below the handler is blamed on the innermost frame of *your* code, not on the
endpoint and not on `time.sleep`).

---

## The thing we are trying to catch

Your server has **one worker**. It serves everyone by taking turns: run a bit of
request A, and the moment A has to wait for something, put A down and pick up B.
That taking-turns is what lets one worker serve hundreds of people.

It only works if code that has to wait **puts the request down**. Code that
instead *sits there waiting* freezes the worker, and everyone else is stuck
behind it.

That is the bug we want to report. It is the single most common serious mistake
in async code, and it is invisible in logs — the request that froze everything
looks perfectly normal in isolation.

---

## What we had, and its three blind spots

We timed every function. When a function finished, we asked: "did that run for
more than 100ms without ever putting the request down?" If yes, we called it
blocking.

That is a fair measure of **how much damage a freeze did**. Keep it. But it
misses three things.

### Blind spot 1 — fast mistakes are invisible

A database call that answers in 3ms is *the same mistake* as one that takes 3
seconds: the worker sat and waited instead of putting the request down. But 3ms
never trips a 100ms threshold, so we say nothing.

It looks fine on your laptop. It becomes an outage the day the database slows
down. **A stopwatch can only find the mistakes that already hurt.**

### Blind spot 2 — a permanent freeze reports nothing

We only judge a function **when it finishes**. If it never finishes — a dead
connection, a deadlock — there is no verdict, ever.

Measured, before the fix, on a request that froze the worker for 2 seconds:

```
t+0.0s   reported: nothing
t+0.5s   reported: nothing        server frozen, dashboard silent
t+1.0s   reported: nothing
t+2.0s   reported: 1 event        only once it was over
```

The worst possible case was the one we were quiet about.

### Blind spot 3 — "waiting" and "working hard" look identical

300ms spent waiting on a file and 300ms spent resizing an image produce exactly
the same event. The first is a bug. The second may be a deliberate choice. We
cannot tell you which, because to a stopwatch they are the same.

---

## The better question

Instead of *"was that slow?"*, ask:

> **Did the worker do something it is never allowed to do?**

The worker is only allowed to wait in **one specific place** — the spot where it
checks "has anything I'm waiting for arrived?". Waiting anywhere else is a
mistake **even if it only took one millisecond**.

That is a yes/no question rather than a how-long question, which is what closes
blind spot 1.

But there is a limit worth stating plainly, because it shapes everything below:
**all async code is ordinary code between the pauses.** "Find the non-async code
in an async request" would flag your whole app. Only two things are worth
catching, and they need different tools:

| | example | how it can be caught |
|---|---|---|
| **A. Waiting on the outside world without pausing** | file, network, database, `sleep` | Yes/no. Catchable at any speed. |
| **B. Computing for a long time without pausing** | big loop, image resize, encryption | Only by timing. No yes/no test exists. |

**A** can be closed completely. **B** cannot — a threshold is unavoidable there.
Any plan that claims to catch "all blocking" is wrong.

---

## What we built: the watchdog

Don't ask the frozen worker whether it is frozen. Ask someone else.

```
   the worker                    the watcher (separate thread)
   ──────────                    ─────────────────────────────
   every 50ms:                   every 50ms:
     "I'm alive"                   how long since the last shout?
                                   longer than 250ms -> it is stuck NOW
    [ FROZEN ]                       take a photo of what it is stuck on
    shouting stops
```

Two pieces: the worker shouts periodically, and a separate watcher notices when
the shouting stops. **The silence is the signal.**

### What this gets right

**It notices while the freeze is happening.** On a 2-second freeze it noticed at
275ms, not at 2 seconds. On a five-minute freeze it would still notice in the
first fraction of a second — the delay is the threshold, never the length of the
freeze.

**It cannot cry wolf.** Three endpoints that each take 1.5 seconds:

| what the request does | longest silence | verdict |
|---|---|---|
| waits properly on an async client | 57ms | fine |
| hands the work to a worker thread | 51ms | fine |
| calls a blocking function directly | **1548ms** | **frozen** (found in 0.26s) |

Same duration, opposite verdicts. Because we measure *whether the worker kept
serving*, a long proper wait can never be mistaken for a freeze. No special
cases needed.

**It sees what we could not.** We only trace your own code, so when a freeze
happens inside somebody else's library we could only say "your function was
slow." The photo shows the whole stack:

```
your_handler
  requests.post          <- library code, invisible to us before
    socket.recv          <- actually stuck here
```

We still *blame* your function, because that is the line you can change —
blaming `time.sleep` would be accurate and useless.

### What it does NOT get right — the cut phone line

**The browser cannot be told while the worker is frozen.**

The message to your browser also travels through the worker. It is like phoning
for help on a line that has been cut: the watcher knows, but cannot get word
out until the worker unfreezes.

Measured — a 3-second freeze:

```
freeze ends at t+3.09s
  alert arrives at the browser  t+3.09s      <- after it is over, not during
```

So the honest summary of what changed:

| | before | after |
|---|---|---|
| a freeze that ends | "something was slow" | **when it started**, how long, and the full photo |
| a freeze that never ends | nothing, ever | recorded on the server; browser still cannot be told |

Better information, arriving at the same moment as before.

**Worked around, cheaply.** The watchdog now writes the stall and its stack to
the log the moment it detects one. Logging is done from the watchdog's own
thread and never touches the loop, so it gets through while the browser cannot:

```
[16:11:02] WARNING event loop stalled 274ms and is still stuck, in library_call
  run_endpoint_function   fastapi/routing.py:352
  freeze                  main.py:17
  library_call            main.py:13
[16:11:05] WARNING event loop recovered after 3042ms
```

The request returned at 16:11:05; the warning landed at 16:11:02. When a server
hangs, the terminal is where you look anyway — and now it tells you what it is
stuck in.

The browser still only learns afterwards. A second connection on its own thread
would fix that properly, but it is a real piece of work and should wait for
evidence that watching a freeze unfold live matters more than getting the stack
immediately in the log.

### One more limit

The watcher needs the frozen worker to come up for air occasionally. Almost all
code does. A few pieces of low-level library code never do, and those can still
hide from it — which is why the watchdog **adds to** the old stopwatch rather
than replacing it. The stopwatch still catches that case.

---

## Which method catches what

| situation | old stopwatch | watchdog | known-bad list | watching OS requests |
|---|---|---|---|---|
| `sleep(5)` | ✓ | ✓ | ✓ | ✓ |
| database query, 3ms | ✗ | ✗ | ✓ | ✓ |
| network call, 2s | ✓ | ✓ | ✓ | ✓ |
| file read, cached, 1ms | ✗ | ✗ | ✓ | ✓ |
| **freezes forever** | ✗ | ✓ (server-side) | ✓ | ✓ |
| heavy computation, 500ms | ✓ | ✓ | ✗ | ✗ |
| heavy computation, 5ms | ✗ | ✗ | ✗ | ✗ |
| library that never comes up for air | ✓ | ✗ | ✗ | ✓ |

Two rows decide the design:

- **Computation, 5ms** — nothing catches it, and nothing should. That is just
  your app working.
- **Library that never comes up for air** — the *old* stopwatch catches this and
  the watchdog cannot. They are complementary; neither replaces the other.

---

## What is left to build, in order

### Step 1 — the watchdog ✅ built

See above. Files: `watchdog.py` (new), `events.py`, `app.py` (`stall_ms=250`,
`0` disables), `dashboard.js`, `tests/test_watchdog.py`.

Outstanding: the docstring in `watchdog.py` still claims live browser reporting
and needs correcting.

### Step 2 — catch the call by what it *is* ✅ built

Keep a list of known-bad calls — `sleep`, network reads, file reads, database
drivers — and report them whenever they happen on the worker, **no matter how
fast they are**. This is the only thing that closes blind spot 1, and the only
one that would have caught the 3ms database call.

Two ways to do it:

- **Swap out the functions** (what the [BlockBuster](https://github.com/cbornet/blockbuster)
  library does). Widest coverage, but it modifies other people's code at
  runtime. Our rule is that we never change how the app behaves, so this would
  have to be opt-in.
- **Use Python's built-in notifications** (`sys.addaudithook`). Python already
  announces some events — opening a file, connecting to a server, starting a
  subprocess. No modification of anything, and a better fit for a tool already
  built on official interpreter features. Honest gap: there is no notification
  for reading from a socket or for `sleep`, so this covers connections and file
  opens, not everything.

Prefer the notifications by default; consider the swap as an opt-in "thorough"
mode.

**Done:** built as `blockingcalls.py`, using audit hooks. A 3ms sqlite connect
and a 1.4ms file read inside an async request are both reported with
`slow_ms=5000`, i.e. with timing effectively switched off. The same calls on a
worker thread are correctly ignored.

**The limitation that matters, found by testing:** Python announces that a
connection was *opened*, not that a query was *sent*. Real apps pool
connections, so the open happens once at startup and every query afterwards is
invisible:

```
/fresh_connect   (connects inside the request)  -> detected: database
/pooled_query    (reuses an open connection)    -> detected: NOTHING
```

So this does not catch database queries in a realistic app — which was the
motivating example. It does catch file reads, subprocess launches, DNS lookups
and the first connection, none of which are pooled. Closing the query gap needs
either the monkeypatch route (patches the driver, so no announcement required)
or step 4.

**Cost, measured:** ~20% throughput (2683 vs 3243 req/s on a trivial endpoint),
because Python announces these events for every library in the process and we
filter them in Python. Kept ON by default: detecting blocking is the point of
the tool, and this is a development-time cost. For reference, tracing itself
already costs ~98% (3040 vs 6009 req/s) — the audit hook is the smaller half of
the bill.

Two filters were needed that the plan did not anticipate:

- **Imports look like file reads.** A lazy import opens a `.py` file on the loop
  inside whatever request triggered it — anyio loads its worker machinery on the
  first `run_in_threadpool` call, which made a *correctly written* endpoint look
  guilty. Anything under the library paths, or ending in a module suffix, is
  skipped.
- **Repeats are collapsed** to one report per (request, category, target). A
  handler reading a file in a loop would otherwise flood the bounded buffer and
  push everything else out.

Config: `visualize(app, detect_blocking_calls=True)`, on by default.

### Step 3 — say which kind it was ✅ built

Once step 2 exists, the two kinds can finally be told apart:

- 🔥 **waited on the outside world** — a real bug. Make it async, or hand it to
  a worker thread.
- ⚙ **heavy computation** — your judgement. Maybe fine, maybe wants a worker
  thread.

Both used to say the single word "blocked". Now the row shows
`🔥 blocking I/O: database` or `⚙ held the loop 1.00s`, and the inspector lists
what was waited on. I/O wins when both are present, because a forbidden wait is
a definite bug while a long hold is only a question.

**The second label is deliberately not "CPU-bound."** The first version said
that, and it mislabelled the single most iconic blocking call there is:

```python
async def async_ep():
    blocking_function()      # time.sleep(1)
```

Detected fine — the timer and the watchdog both fired — but the listener saw
nothing, because `time.sleep` raises no audit event, and the watchdog's stack
could not help either since `time.sleep` is C and leaves no Python frame. The
verdict logic read "no wait detected" as "therefore computation" and printed
⚙ CPU-bound for a pure sleep.

Absence of evidence is not evidence of computation. The label now states only
what is known — it held the loop this long — and the inspector spells out that
the cause is unknown: computation, or a wait we cannot see. Same principle as
the UNTRACED state elsewhere in this tool.

### Step 4 — watch the operating system directly (optional, Linux) — not started

Worth more than it first appeared: it is the only technique that sees a query on
an already-open pooled connection, because it watches the actual read and write
rather than waiting for Python to announce something. Still Linux-plus-root, so
it belongs as a documented recipe rather than code we maintain and cannot test.

The only method with essentially no misses, and the only one that sees through
libraries that never come up for air. Needs Linux and admin rights, so it can
never be the default — ship it as an opt-in power mode or a documented recipe.

### Step 0 — a linter ✅ done

Ruff's `ASYNC` rules are configured in `pyproject.toml`, with the demo and tests
exempted since they block on purpose. Our own source passes clean, and the rules
do catch the real thing:

```
ASYNC251 Async functions should not call `time.sleep`
ASYNC210 Async functions should not call blocking HTTP methods
```

This is the one detector that sees code paths no request ever exercises. It
needs no CI to be useful — anyone running `ruff check` gets it — and CI will
pick it up whenever that task lands.

---

## Why this belongs in this tool

Other tools stop at "something blocked". This one already knows which request,
which task, and the whole call tree — so any of the methods above becomes:

> request `#a3f21c` froze the loop in `db.fetch → socket.recv`

Knowing *which request* is the difference between a log line and a fix.

---

## Rules this has to respect

- Python 3.12+; check for features rather than assuming them.
- Nothing here may ever break a request — every new path fails quietly.
- Do not change how the app behaves by default. Same reasoning that removed
  `loop.set_debug(True)`.
- The dashboard stays plain JavaScript: no build step, works offline.
- Off unless explicitly enabled.

## Decided

- **Do we want real live alerting?** No — not a second connection. The watchdog
  writes the stall and its stack to the **log** from its own thread, immediately.
  That is where you look when a server hangs, and it costs nothing. The dashboard
  catches up when the loop recovers. Measured: a 3.0s freeze logs at 3.09s, and
  the browser sees it only afterwards.
- **Python's notifications cannot be removed once switched on — does that clash
  with turning the tool off?** In practice, no. The hook stays installed for the
  process lifetime, but it returns immediately unless there is an active trace on
  the loop thread, so a disabled visualizer costs one predicate per audit event.
  `detect_blocking_calls=False` skips installing it in the first place.
- **How much does the watcher cost under load?** Measured on the demo:
  6009 req/s clean → 3040 with tracing → 2683 with the listener as well. So the
  listener is roughly 20% on top of tracing, and tracing is the expensive half.
  Kept **on** by default: catching blocking calls is the point of the tool, and
  the tool is dev-time only.
- **Should the watchdog have its own threshold?** Yes, confirmed. `stall_ms`
  defaults to 250 against the timer's `slow_ms` of 100 — "is it stuck?" wants a
  larger number than "was that slow?", and it must stay well clear of the 50ms
  heartbeat or a healthy loop trips it. `stall_ms=0` disables the watchdog.
