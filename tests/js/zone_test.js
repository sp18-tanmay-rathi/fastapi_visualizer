// Where does a request's row live, and where does its offloaded work show up?
//
// Measured basis for these expectations: `await run_in_threadpool(f)` leaves
// the request's coroutine SUSPENDED on the event loop — its own frames only
// ever run on the loop thread, and the loop stays as free as during
// `await asyncio.sleep()`. Only `f` runs on a worker. So the request keeps its
// row in the EVENT LOOP zone and the worker's activity appears separately.
//
// Regression for: a request that offloaded once was moved to THREADPOOL and
// stranded there for the rest of its life.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadAll } = require("./_sources");

const T0 = 517342.5;
const FRAME_MS = 16.7;

function harness() {
  let clock = 0;
  const els = {};
  let texts = [];
  let placed = [];
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === "measureText") return () => ({ width: 10 });
      if (p === "fillText")
        return (s, x, y) => {
          texts.push(String(s));
          placed.push({ s: String(s), x: Math.round(x), y: Math.round(y) });
        };
      return p in t ? t[p] : () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  function el(id) {
    if (!els[id]) els[id] = {
      id, textContent: "", value: "", hidden: false, checked: false, disabled: false,
      style: {}, innerHTML: "", classList: { add() {}, remove() {}, toggle() { return false; } },
      _h: {}, addEventListener(e, f) { this._h[e] = f; },
      // The real DOM has these. The dashboard now drives tab state through
      // aria-selected and focuses the filter box, so the stub needs them.
      _attrs: {},
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      focus() {}, blur() {}, select() {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      offsetHeight: 37, clientWidth: 1200, clientHeight: 800,
      getContext: () => ctx, width: 1200, height: 800,
    };
    return els[id];
  }
  let rafCb = null, ws = null;
  const sb = {
    document: {
      getElementById: el,
      querySelector: () => el("header"),
      // Keyboard shortcuts bind at the document; `activeElement` is what the
      // handler consults to avoid stealing Space from a focused input.
      activeElement: null,
      _keys: {},
      addEventListener(ev, fn) { this._keys[ev] = fn; },
    },
    window: { addEventListener() {}, innerWidth: 1200, innerHeight: 837 },
    performance: { now: () => clock },
    requestAnimationFrame: (cb) => { rafCb = cb; },
    location: { protocol: "http:", host: "h", pathname: "/_viz/" },
    WebSocket: function () { ws = this; setTimeout(() => this.onopen && this.onopen(), 0); },
    setTimeout: (fn) => { fn(); return 0; },
    JSON, Math, console, String, Number, Array, Object, Map, Set, RegExp,
    isNaN, parseInt, parseFloat, Infinity,
  };
  sb.self = sb;
  vm.createContext(sb);
  loadAll(vm, sb);
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ events: [
    { seq: 1, t: T0 - 60, kind: "pool_sample", trace_id: null, task_id: null, name: "tp",
      extra: { borrowed: 0, total: 40, queued: 0 } }] }) });

  return {
    frame: (evs) => ws.onmessage({ data: JSON.stringify({ events: evs }) }),
    tick(seconds) {
      const n = Math.round((seconds * 1000) / FRAME_MS);
      for (let i = 0; i < n; i++) { clock += FRAME_MS; texts = []; placed = []; if (rafCb) rafCb(); }
    },
    drawn: () => texts.slice(),
    el,
    // Drive the row cap the way the header control does.
    setMaxReq(v) {
      const inp = el("ld-maxreq");
      inp.value = String(v);
      if (inp._h.input) inp._h.input({});
    },
    at: (label) => placed.find((e) => e.s === label) || null,
    has: (frag) => texts.some((t) => t.includes(frag)),
    loopRows() {
      const line = texts.find((t) => t.includes("shown"));
      const m = line && line.match(/(\d+)\s+shown/);
      return m ? Number(m[1]) : null;
    },
    stepMode(on) { const t = el("ld-step"); t.checked = on; if (t._h.change) t._h.change(); },
    step() { const b = el("ld-step-btn"); if (b._h.click) b._h.click({ clientX: 0, clientY: 0 }); },
  };
}

let seq = 10;
const TR = "aaaaaaaaaaaaaaaa";
const ev = (t, kind, extra) => ({ seq: seq++, t, kind, trace_id: TR, task_id: 1, name: "f", extra });
const enter = (t, node, parent, exec, qual) =>
  ev(t, "call_enter", { node_id: node, parent_id: parent, qualname: qual,
                        file: "a.py", line: 1, is_async: exec === "event_loop", execution: exec });

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  PASS  " + name); }
  catch (e) { failures++; console.log("  FAIL  " + name + "\n        " + e.message); }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); }

// the /async endpoint: awaits i/o, then awaits run_in_threadpool, then resumes
function asyncWithOffload(h) {
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/async", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_ep"),
    // Measured against the real backend: `await run_in_threadpool(f)` yields
    // the coroutine BEFORE the worker frame opens, so the suspend always
    // precedes offload_start. Omitting it left the loop-holder claim standing
    // and made this fixture describe a stream the monitor never emits.
    ev(T0 + 0.09, "suspend", { node_id: 1, awaiting: "run_in_threadpool" }),
    enter(T0 + 0.10, 2, 1, "threadpool", "blocking_function"),
    ev(T0 + 0.101, "offload_start", { node_id: 2 }),
  ]);
}
function offloadReturns(h) {
  h.frame([
    ev(T0 + 0.40, "offload_end", { node_id: 2 }),
    ev(T0 + 0.4005, "resume", { node_id: 1 }),
    ev(T0 + 0.401, "call_exit", { node_id: 2 }),
    enter(T0 + 0.41, 3, 1, "event_loop", "serialize"),
    ev(T0 + 0.45, "call_exit", { node_id: 3 }),
    ev(T0 + 0.46, "call_exit", { node_id: 1 }),
    ev(T0 + 0.47, "request_end", { status: 200, duration_ms: 470 }),
  ]);
}

check("the request never leaves the EVENT LOOP zone", () => {
  const h = harness();
  h.tick(1);
  asyncWithOffload(h);
  h.tick(1.2);
  eq(h.loopRows(), 1, "rows in the loop zone during the offload");
  offloadReturns(h);
  h.tick(2);
  eq(h.loopRows(), 1, "rows in the loop zone after it finishes");
});

check("while offloaded the row reads WAITING · worker", () => {
  const h = harness();
  h.tick(1);
  asyncWithOffload(h);
  h.tick(1.2);
  if (!h.has("WAITING · worker")) {
    throw new Error("expected the worker state, got: " + JSON.stringify(h.drawn().filter((t) => /RUNNING|WAITING|DONE/.test(t))));
  }
});

check("the offloaded CALL appears in the threadpool zone while it runs", () => {
  const h = harness();
  h.tick(1);
  asyncWithOffload(h);
  h.tick(1.2);
  if (!h.has("on worker")) throw new Error("no worker entry rendered");
  if (!h.has("blocking_function")) throw new Error("worker entry is unlabelled");
});

check("the worker entry disappears when the call returns", () => {
  const h = harness();
  h.tick(1);
  asyncWithOffload(h);
  h.tick(1.2);
  if (!h.has("on worker")) throw new Error("precondition: no worker entry");
  offloadReturns(h);
  h.tick(2);
  if (h.has("on worker")) throw new Error("worker entry outlived the call");
});

check("the finished row still records the offload", () => {
  const h = harness();
  h.tick(1);
  asyncWithOffload(h);
  h.tick(1.2);
  offloadReturns(h);
  h.tick(2);
  if (!h.has("DONE")) throw new Error("expected the row to finish");
  if (!h.drawn().some((t) => t.startsWith("⇢ pool"))) {
    throw new Error("finished row shows no record of the offload");
  }
});

check("a purely sync request lives in THREADPOOL, with no duplicate entry", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/sync", request_id: null }),
    enter(T0 + 0.001, 1, null, "threadpool", "sync_ep"),
    ev(T0 + 0.002, "offload_start", { node_id: 1 }),
  ]);
  h.tick(1.2);
  eq(h.loopRows(), 0, "rows in the loop zone");
  // the request IS the offloaded work here; a worker entry would double it up
  if (h.has("on worker")) throw new Error("sync request duplicated as a worker entry");
});

check("a dropped offload_end cannot leave a finished row stuck on a worker", () => {
  const h = harness();
  h.tick(1);
  asyncWithOffload(h);
  h.tick(1.2);
  h.frame([ev(T0 + 0.47, "request_end", { status: 200, duration_ms: 470 })]); // no offload_end
  h.tick(2);
  eq(h.loopRows(), 1, "row still in the loop zone");
  if (h.has("on worker")) throw new Error("worker entry survived request_end");
});

check("STEP MODE stops at each offload boundary", () => {
  const h = harness();
  h.stepMode(true);
  h.tick(0.5);
  asyncWithOffload(h);
  offloadReturns(h);
  h.tick(0.5);
  let sawWorker = false;
  for (let i = 0; i < 8; i++) {
    h.step();
    h.tick(0.2);
    if (h.has("on worker")) sawWorker = true;
  }
  if (!sawWorker) throw new Error("stepping never showed the work on a worker");
});

check("a PARENTLESS offloaded frame still cannot move the row", () => {
  // Defence in depth. monitor.py now gives offloaded frames a real parent (via
  // a contextvar copied into the worker thread), so normally they cannot be
  // mistaken for a request root. But that parent is absent if the offload
  // happens with no in-root frame active, if the parent's call_enter was shed
  // by the bounded buffer, or if the server predates the parenting fix.
  // Zone must not depend on it: this is the exact shape that stranded an async
  // request in THREADPOOL for the rest of its life.
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/async", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_ep"),
    enter(T0 + 0.10, 2, null, "threadpool", "blocking_function"), // parent_id NULL
    ev(T0 + 0.101, "offload_start", { node_id: 2 }),
  ]);
  h.tick(1.2);
  eq(h.loopRows(), 1, "row during a parentless offload");

  h.frame([
    ev(T0 + 0.40, "offload_end", { node_id: 2 }),
    ev(T0 + 0.401, "call_exit", { node_id: 2 }),
    ev(T0 + 0.47, "request_end", { status: 200, duration_ms: 470 }),
  ]);
  h.tick(2);
  eq(h.loopRows(), 1, "row after a parentless offload");
});

check("a request parked on a worker does not claim the event loop", () => {
  // The whole point of offloading: while B's work runs on a worker, B is
  // SUSPENDED and the loop is free for A. If B's threadpool frame claimed the
  // loop holder, the dashboard would show the loop busy when it is idle --
  // the opposite of what the tool exists to teach.
  const h = harness();
  h.tick(1);
  const A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb";
  const mk = (tr) => (t, kind, extra) =>
    ({ seq: seq++, t, kind, trace_id: tr, task_id: 1, name: "f", extra });
  const a = mk(A), b = mk(B);
  const call = (f) => (t, node, parent, exec, qual) =>
    f(t, "call_enter", { node_id: node, parent_id: parent, qualname: qual,
                         file: "x.py", line: 1, is_async: exec === "event_loop",
                         execution: exec });

  h.frame([
    // B starts, then parks on a worker
    b(T0, "request_start", { method: "GET", path: "/b", request_id: null }),
    call(b)(T0 + 0.001, 10, null, "event_loop", "b_handler"),
    // A starts and is genuinely running on the loop
    a(T0 + 0.002, "request_start", { method: "GET", path: "/a", request_id: null }),
    call(a)(T0 + 0.003, 20, null, "event_loop", "a_handler"),
    // now B's offloaded call begins on a worker thread
    call(b)(T0 + 0.004, 11, 10, "threadpool", "b_blocking"),
    b(T0 + 0.005, "offload_start", { node_id: 11 }),
  ]);
  h.tick(1.2);

  const drawn = h.drawn().join(" | ");
  // A is the one on the loop, so A must read RUNNING
  if (!drawn.includes("RUNNING")) {
    throw new Error("nobody holds the loop; expected A to: " + drawn);
  }
  // and B must read as parked on a worker, not running
  if (!drawn.includes("WAITING · worker")) {
    throw new Error("B should be parked on a worker: " + drawn);
  }
});

// gather(): one trace, two children, one of each kind
//
// `install_task_factory` copies a parent's trace id onto its child tasks, so
// `gather(run_in_threadpool(a), b())` gives ONE trace a worker-bound child and
// a loop-bound sibling at the same instant. Checking liveOffloads before the
// loop-holder claim reported "WAITING · worker" while the loop was
// demonstrably busy with this very request.
function gatherChildren(h) {
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/gather", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "gather_ep"),
    ev(T0 + 0.005, "suspend", { node_id: 1, awaiting: "gather" }),
    // child A -> worker thread
    enter(T0 + 0.01, 2, 1, "threadpool", "blocking_child"),
    ev(T0 + 0.011, "offload_start", { node_id: 2 }),
    // child B -> genuinely executing on the loop, same trace id
    enter(T0 + 0.02, 3, 1, "event_loop", "loop_child"),
  ]);
}

check("a loop-bound sibling outranks a live offload on the same trace", () => {
  const h = harness();
  h.tick(1);
  gatherChildren(h);
  h.tick(0.25);
  if (h.has("WAITING · worker"))
    throw new Error(
      "row claims the request is only waiting on a worker, but loop_child is " +
      "executing on the loop right now: " + h.drawn().join(" | ")
    );
  if (!h.has("RUNNING"))
    throw new Error("expected RUNNING, drawn: " + h.drawn().join(" | "));
});

check("a STALE holder claim does NOT outrank a live offload", () => {
  const h = harness();
  h.tick(1);
  gatherChildren(h);
  // Push playback past UNTRACED_AFTER (0.15s) without ending the offload:
  // "a worker is definitely busy" beats "the loop last touched this trace a
  // while ago".
  h.frame([ev(T0 + 1.2, "pool_sample", { borrowed: 1, total: 40, queued: 0 })]);
  h.tick(2);
  if (h.has("UNTRACED"))
    throw new Error("a stale holder claim won over a live offload");
  if (!h.has("WAITING · worker"))
    throw new Error("expected WORKER, drawn: " + h.drawn().join(" | "));
});

check("a live stall paints the loop spine and names the culprit", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/freeze", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "freeze"),
    ev(T0 + 0.10, "loop_stalled", {
      qualname: "library_call",
      node_id: 1,
      detected_after_ms: 120,
      stack: [
        { qualname: "freeze", file: "/app/main.py", line: 10 },
        { qualname: "library_call", file: "/app/main.py", line: 20 },
        { qualname: "Session.request", file: "/venv/lib/python3.12/site-packages/requests/sessions.py", line: 500 },
      ],
    }),
  ]);
  h.tick(1.5);
  if (!h.has("LOOP STALLED")) throw new Error("no stall shown: " + h.drawn().join(" | "));
  if (!h.has("library_call")) throw new Error("culprit not named");
  // the deepest frame says WHAT it is stuck in, even though it is library code
  if (!h.has("Session.request")) throw new Error("deepest frame not shown");
});

check("the stall clears when the loop recovers", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/freeze", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "freeze"),
    ev(T0 + 0.10, "loop_stalled", { qualname: "library_call", node_id: 1, stack: [] }),
  ]);
  h.tick(1.2);
  if (!h.has("LOOP STALLED")) throw new Error("precondition: no stall shown");
  h.frame([ev(T0 + 0.60, "loop_unstalled", { duration_ms: 500 })]);
  h.tick(2);
  if (h.has("LOOP STALLED")) throw new Error("stall outlived loop_unstalled");
});

check("a fast blocking call is verdicted as blocking I/O, with no timing", () => {
  // No loop_blocked at all here -- the call was too fast to time. The verdict
  // comes from WHAT the call was, which is the whole point.
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/w", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "handler"),
    ev(T0 + 0.002, "blocking_call", {
      category: "database", audit_event: "sqlite3.connect",
      detail: ":memory:", node_id: 1, qualname: "handler",
    }),
    ev(T0 + 0.01, "call_exit", { node_id: 1 }),
    ev(T0 + 0.011, "request_end", { status: 200, duration_ms: 11 }),
  ]);
  h.tick(2);
  if (!h.has("blocking I/O")) {
    throw new Error("no I/O verdict: " + h.drawn().join(" | "));
  }
  if (!h.has("database")) throw new Error("category not shown");
  if (h.has("held the loop")) throw new Error("must not also report an unknown cause");
});

check("a long hold with no detected wait is reported WITHOUT guessing a cause", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/w", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "crunch"),
    ev(T0 + 0.001, "loop_blocked", { node_id: 1, qualname: "crunch", duration_ms: 300 }),
    ev(T0 + 0.301, "loop_unblocked", { node_id: 1, qualname: "crunch", duration_ms: 300 }),
    ev(T0 + 0.31, "call_exit", { node_id: 1 }),
    ev(T0 + 0.32, "request_end", { status: 200, duration_ms: 320 }),
  ]);
  h.tick(3);
  // Must NOT claim "CPU-bound": time.sleep raises no audit event and leaves no
  // Python frame, so no-evidence cannot be read as proof of computation.
  if (!h.has("held the loop")) {
    throw new Error("no hold reported: " + h.drawn().join(" | "));
  }
  if (h.has("CPU-bound")) throw new Error("must not claim a cause it cannot know");
  if (h.has("blocking I/O")) throw new Error("no evidence of I/O; must not claim it");
});

check("when both are present, I/O wins the verdict", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/w", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "handler"),
    ev(T0 + 0.002, "blocking_call", {
      category: "socket", audit_event: "socket.connect",
      detail: "", node_id: 1, qualname: "handler",
    }),
    ev(T0 + 0.002, "loop_blocked", { node_id: 1, qualname: "handler", duration_ms: 400 }),
    ev(T0 + 0.402, "loop_unblocked", { node_id: 1, qualname: "handler", duration_ms: 400 }),
    ev(T0 + 0.41, "request_end", { status: 200, duration_ms: 410 }),
  ]);
  h.tick(3);
  if (!h.has("blocking I/O")) throw new Error("expected the I/O verdict");
  if (h.has("held the loop")) throw new Error("I/O evidence must take precedence");
});

check("a stall marks the guilty ROW, not just the top of the zone", () => {
  // The banner used to be drawn at the top of the spine, which is exactly
  // where the FIRST row prints its own "#id STATE" header — the two collided
  // into unreadable text. Worse, it described whichever request was stuck even
  // though that row might be scrolled out of sight.
  const h = harness();
  h.tick(1);
  const A = (t, k, x) => ({ seq: seq++, t, kind: k, trace_id: "a".repeat(16), task_id: 1, name: "f", extra: x });
  const B = (t, k, x) => ({ seq: seq++, t, kind: k, trace_id: "b".repeat(16), task_id: 1, name: "f", extra: x });
  const call = (f) => (t, n, p, ex, q) =>
    f(t, "call_enter", { node_id: n, parent_id: p, qualname: q, file: "d.py", line: 1,
                         is_async: ex === "event_loop", execution: ex });
  h.frame([
    A(T0, "request_start", { method: "GET", path: "/async", request_id: null }),
    call(A)(T0 + 0.001, 1, null, "event_loop", "async_ep"),
    A(T0 + 0.002, "suspend", { node_id: 1, awaiting: "db_fetch" }),
    B(T0 + 0.003, "request_start", { method: "GET", path: "/blocking", request_id: null }),
    call(B)(T0 + 0.004, 2, null, "event_loop", "blocking_ep"),
    B(T0 + 0.005, "loop_stalled", { qualname: "blocking_ep", node_id: 2, stack: [] }),
  ]);
  h.tick(1.5);

  if (!h.has("STALLED")) throw new Error("no stall shown at all");
  if (!h.has("blocking_ep")) throw new Error("the frozen function is not named");
  // the innocent request must still read as waiting, not stalled
  if (!h.has("WAITING")) {
    throw new Error("the other request lost its state: " + h.drawn().join(" | "));
  }

  // and it clears on the right row when the loop recovers
  h.frame([B(T0 + 1.0, "loop_unstalled", { duration_ms: 995 })]);
  h.tick(2);
  if (h.has("⏱ STALLED")) throw new Error("row still marked stalled after recovery");
});

check("a collapsed row shows the live frame, then collapses back when done", () => {
  // Pinning the frames that blocked into the finished row was tried and
  // reverted: it left wide nodes hanging around, colliding with the row's own
  // tag, for information that belongs in the inspector.
  const h = harness();
  h.tick(1);
  const nodes = () =>
    h.drawn().filter((t) => /^(GET |async_ep|blocking_function)/.test(t));

  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/async", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_ep"),
    enter(T0 + 0.20, 2, 1, "event_loop", "blocking_function"),
  ]);
  h.tick(1.5);
  if (!nodes().includes("blocking_function")) {
    throw new Error("running row must show the live frame: " + nodes().join(","));
  }

  h.frame([
    ev(T0 + 0.20, "loop_blocked", { node_id: 2, qualname: "blocking_function", duration_ms: 505 }),
    ev(T0 + 0.705, "loop_unblocked", { node_id: 2, qualname: "blocking_function", duration_ms: 505 }),
    ev(T0 + 0.706, "call_exit", { node_id: 2 }),
    ev(T0 + 0.72, "call_exit", { node_id: 1 }),
    ev(T0 + 0.73, "request_end", { status: 200, duration_ms: 730 }),
  ]);
  h.tick(6);
  const after = nodes();
  if (after.length !== 1 || !after[0].startsWith("GET ")) {
    throw new Error("finished row should collapse to the request: " + after.join(","));
  }
  if (!h.drawn().some((t) => t.includes("held the loop"))) {
    throw new Error("finished row lost its hold summary");
  }
});

check("a stall and its later loop_blocked are ONE span, not two", () => {
  // The watchdog opens a span while the frame is still stuck; loop_blocked
  // closes it out afterwards. Appending both listed a single blocking call
  // twice -- once as "still running", once with its duration -- and inflated
  // the span count past the number of calls actually made.
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/async", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_ep"),
    enter(T0 + 0.20, 2, 1, "event_loop", "blocking_function"),
    ev(T0 + 0.205, "loop_stalled", { qualname: "blocking_function", node_id: 2, stack: [] }),
    ev(T0 + 0.70, "loop_unstalled", { duration_ms: 500 }),
    ev(T0 + 0.20, "loop_blocked", { node_id: 2, qualname: "blocking_function", duration_ms: 505 }),
    ev(T0 + 0.705, "loop_unblocked", { node_id: 2, qualname: "blocking_function", duration_ms: 505 }),
    ev(T0 + 0.706, "call_exit", { node_id: 2 }),
    ev(T0 + 0.72, "call_exit", { node_id: 1 }),
    ev(T0 + 0.73, "request_end", { status: 200, duration_ms: 730 }),
  ]);
  h.tick(6);
  // one blocking call was made, so the row must not claim two
  if (h.drawn().some((t) => t.includes("×2"))) {
    throw new Error("one call counted twice: " + h.drawn().join(" | "));
  }
  if (!h.drawn().some((t) => t.includes("held the loop"))) {
    throw new Error("the hold was not reported at all");
  }
});

// A sync endpoint's row IS the worker, so a "⇢ pool" chip on it restates the
// row's own zone — and puts a second, smaller number next to the request
// total, which reads as a contradiction rather than a breakdown. The per-node
// stub was already suppressed in this zone; the durable chip had been missed.
check("a THREADPOOL row does not also carry a ⇢ pool chip", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/sync", request_id: null }),
    enter(T0 + 0.001, 1, null, "threadpool", "sync_ep"),
    ev(T0 + 0.002, "offload_start", { node_id: 1 }),
    ev(T0 + 0.41, "offload_end", { node_id: 1 }),
    ev(T0 + 0.411, "call_exit", { node_id: 1 }),
    ev(T0 + 0.72, "request_end", { status: 200, duration_ms: 718 }),
  ]);
  h.tick(1.5);
  const chip = h.drawn().find((t) => t.indexOf("pool") >= 0 && /\d+ms/.test(t));
  if (chip) throw new Error("threadpool row still carries: " + chip);
});

check("a LOOP row that offloaded still carries its ⇢ pool chip", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/offloaded", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "offloaded_ep"),
    ev(T0 + 0.09, "suspend", { node_id: 1, awaiting: "run_in_threadpool" }),
    enter(T0 + 0.10, 2, 1, "threadpool", "query_db"),
    ev(T0 + 0.101, "offload_start", { node_id: 2 }),
    ev(T0 + 0.30, "offload_end", { node_id: 2 }),
    ev(T0 + 0.301, "call_exit", { node_id: 2 }),
    ev(T0 + 0.302, "resume", { node_id: 1 }),
    ev(T0 + 0.303, "call_exit", { node_id: 1 }),
    ev(T0 + 0.304, "request_end", { status: 200, duration_ms: 304 }),
  ]);
  h.tick(1.5);
  if (!h.drawn().some((t) => t.indexOf("pool") >= 0))
    throw new Error("a loop row that used a worker lost its evidence: " + h.drawn().join(" | "));
});

// The one place the tool can honestly say "waiting FOR a worker": the limiter
// reports how many calls are queued for a free thread. It arrives on every
// pool_sample and had never been displayed anywhere.
check("a saturated pool reports how many calls are waiting for a thread", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    { seq: 900, t: T0, kind: "pool_sample", trace_id: null, task_id: null, name: "tp",
      extra: { borrowed: 40, total: 40, queued: 7 } },
  ]);
  h.tick(0.5);
  if (!h.has("7 waiting for a free thread"))
    throw new Error("queue depth not surfaced: " + h.drawn().join(" | "));
});

check("an idle pool does not mention a queue at all", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    { seq: 901, t: T0, kind: "pool_sample", trace_id: null, task_id: null, name: "tp",
      extra: { borrowed: 0, total: 40, queued: 0 } },
  ]);
  h.tick(0.5);
  if (h.has("waiting for a free thread"))
    throw new Error("an idle pool should say nothing about queueing");
});

// --- a request refused by the row cap keeps its name ----------------------
//
// getOrCreateBranch refuses a new trace at the cap when nothing kept is done,
// and deliberately retries later. But method/path ride only on request_start,
// so by the time the trace was admitted its identity had gone and the row drew
// "? ?". Fifty concurrent requests at a ten-row cap lost forty names.

// MAX_REQ defaults to 10, so eleven never-finishing requests overflow it
// without needing to drive the header control.
function startRequest(h, tid, path, t, node) {
  h.frame([
    { seq: seq++, t: t, kind: "request_start", trace_id: tid, task_id: 1, name: "r",
      extra: { method: "GET", path: path, request_id: null } },
    { seq: seq++, t: t + 0.001, kind: "call_enter", trace_id: tid, task_id: 1, name: "f",
      extra: { node_id: node, parent_id: null, qualname: "handler",
               file: "a.py", line: 1, is_async: true, execution: "event_loop" } },
  ]);
}

check("a request the cap turned away is not shown at all", () => {
  const h = harness();
  h.tick(1);
  h.setMaxReq(2);
  h.tick(0.2);

  // fill both slots with requests that never finish
  startRequest(h, "cap0000000000000", "/held0", T0, 500);
  startRequest(h, "cap0000000000001", "/held1", T0 + 0.001, 501);
  // the third has nowhere to go
  startRequest(h, "late000000000001", "/third", T0 + 0.02, 600);
  h.tick(0.8);

  // free a slot, then send a LATER event for the refused trace. It must NOT
  // materialise a row: that row would appear to start late and its tree would
  // be missing every call made while it was refused.
  h.frame([
    { seq: seq++, t: T0 + 0.30, kind: "call_exit", trace_id: "cap0000000000000",
      task_id: 1, name: "f", extra: { node_id: 500 } },
    { seq: seq++, t: T0 + 0.31, kind: "request_end", trace_id: "cap0000000000000",
      task_id: 1, name: "r", extra: { status: 200, duration_ms: 310 } },
    { seq: seq++, t: T0 + 0.40, kind: "call_enter", trace_id: "late000000000001",
      task_id: 1, name: "f",
      extra: { node_id: 601, parent_id: null, qualname: "handler",
               file: "a.py", line: 1, is_async: true, execution: "event_loop" } },
  ]);
  h.tick(1.5);

  const drawn = h.drawn().join(" | ");
  if (/\? \?/.test(drawn))
    throw new Error("a refused request materialised a nameless row: " + drawn);
  if (drawn.indexOf("/third") >= 0)
    throw new Error("a refused request appeared late, mid-flight: " + drawn);
});

check("the requests it withheld are counted in the alert strip", () => {
  const h = harness();
  h.tick(1);
  h.setMaxReq(2);
  h.tick(0.2);
  startRequest(h, "cap0000000000000", "/held0", T0, 500);
  startRequest(h, "cap0000000000001", "/held1", T0 + 0.001, 501);
  startRequest(h, "late000000000001", "/x", T0 + 0.02, 600);
  startRequest(h, "late000000000002", "/y", T0 + 0.03, 601);
  h.tick(0.8);

  const warn = h.el("cap-warn");
  if (warn.hidden) throw new Error("two requests were withheld and nothing said so");
  if (h.el("cap-count").textContent !== "2")
    throw new Error("expected 2 withheld, got " + h.el("cap-count").textContent);
});

check("nothing is withheld when the cap is not reached", () => {
  const h = harness();
  h.tick(1);
  startRequest(h, "aaaaaaaaaaaaaaa1", "/one", T0, 500);
  h.tick(0.6);
  if (!h.el("cap-warn").hidden)
    throw new Error("the cap notice showed with room to spare");
});

// --- the busy count cannot be sampled away --------------------------------
//
// pool_sample is pushed only when the numbers change, and is polled from a
// task on the loop — so it can be stale while rows are visibly running, and
// step mode freezes that window on screen.

check("live offloads count as busy even with a stale pool sample", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    // the sampler last said nobody is busy...
    { seq: seq++, t: T0, kind: "pool_sample", trace_id: null, task_id: null, name: "tp",
      extra: { borrowed: 0, total: 40, queued: 0 } },
    // ...while two offloads are demonstrably in flight
    ev(T0 + 0.01, "request_start", { method: "GET", path: "/sync", request_id: null }),
    enter(T0 + 0.011, 1, null, "threadpool", "sync_ep"),
    ev(T0 + 0.012, "offload_start", { node_id: 1 }),
    enter(T0 + 0.013, 2, 1, "threadpool", "query_db"),
    ev(T0 + 0.014, "offload_start", { node_id: 2 }),
  ]);
  h.tick(0.8);
  if (h.has("0/40 busy"))
    throw new Error("header claims an idle pool while offloads run: " + h.drawn().join(" | "));
  if (!h.has("2/40 busy"))
    throw new Error("expected 2/40 busy, drawn: " + h.drawn().join(" | "));
});

check("the threadpool header reports live and shown, like the loop zone", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/sync", request_id: null }),
    enter(T0 + 0.001, 1, null, "threadpool", "sync_ep"),
    ev(T0 + 0.30, "call_exit", { node_id: 1 }),
    ev(T0 + 0.31, "request_end", { status: 200, duration_ms: 310 }),
  ]);
  h.tick(1.2);
  // one finished row: 0 live, 1 shown — which is what makes "0 busy" and a
  // visible row stop looking like a contradiction
  if (!h.has("0 live · 1 shown"))
    throw new Error("threadpool header missing live/shown: " + h.drawn().join(" | "));
});

console.log(failures === 0 ? "\nall zone tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
