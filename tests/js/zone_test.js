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

const DASHBOARD = path.join(__dirname, "..", "..", "src", "fastapi_visualizer", "static", "dashboard.js");
const T0 = 517342.5;
const FRAME_MS = 16.7;

function harness() {
  let clock = 0;
  const els = {};
  let texts = [];
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === "measureText") return () => ({ width: 10 });
      if (p === "fillText") return (s) => texts.push(String(s));
      return p in t ? t[p] : () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  function el(id) {
    if (!els[id]) els[id] = {
      id, textContent: "", value: "", hidden: false, checked: false, disabled: false,
      style: {}, innerHTML: "", classList: { add() {}, remove() {}, toggle() { return false; } },
      _h: {}, addEventListener(e, f) { this._h[e] = f; },
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      offsetHeight: 37, clientWidth: 1200, clientHeight: 800,
      getContext: () => ctx, width: 1200, height: 800,
    };
    return els[id];
  }
  let rafCb = null, ws = null;
  const sb = {
    document: { getElementById: el, querySelector: () => el("header") },
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
  vm.runInContext(fs.readFileSync(DASHBOARD, "utf8"), sb, { filename: DASHBOARD });
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ events: [
    { seq: 1, t: T0 - 60, kind: "pool_sample", trace_id: null, task_id: null, name: "tp",
      extra: { borrowed: 0, total: 40, queued: 0 } }] }) });

  return {
    frame: (evs) => ws.onmessage({ data: JSON.stringify({ events: evs }) }),
    tick(seconds) {
      const n = Math.round((seconds * 1000) / FRAME_MS);
      for (let i = 0; i < n; i++) { clock += FRAME_MS; texts = []; if (rafCb) rafCb(); }
    },
    drawn: () => texts.slice(),
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
    enter(T0 + 0.10, 2, 1, "threadpool", "blocking_function"),
    ev(T0 + 0.101, "offload_start", { node_id: 2 }),
  ]);
}
function offloadReturns(h) {
  h.frame([
    ev(T0 + 0.40, "offload_end", { node_id: 2 }),
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

console.log(failures === 0 ? "\nall zone tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
