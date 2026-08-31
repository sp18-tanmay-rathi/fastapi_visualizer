// Zone classification: which band does a request's row end up in?
//
// Regression for: an async request that offloaded work (a sync DB call via
// sync_to_async / run_in_threadpool) got stranded in the THREADPOOL zone even
// though it resumed on the event loop and finished there. Cause: a worker
// thread starts with an empty thread-local stack, so its first frame reports
// parent_id null and looked like a request root, reassigning the zone.
//
// Observed through the EVENT LOOP zone header, which renders "... N live ·
// M shown" — so "shown" tells us how many rows the loop zone holds.

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
  // first frame is the discarded on-connect backlog
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
    stepMode(on) {
      const t = el("ld-step");
      t.checked = on;
      if (t._h.change) t._h.change();
    },
    step() {
      const b = el("ld-step-btn");
      if (b._h.click) b._h.click({ clientX: 0, clientY: 0 });
    },
    // rows currently rendered in the EVENT LOOP zone
    loopRows() {
      const line = texts.find((t) => t.includes("shown"));
      if (!line) return null;
      const m = line.match(/(\d+)\s+shown/);
      return m ? Number(m[1]) : null;
    },
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

check("a purely sync request stays in the THREADPOOL zone", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/sync", request_id: null }),
    enter(T0 + 0.001, 1, null, "threadpool", "sync_view"),
    enter(T0 + 0.002, 2, 1, "threadpool", "query_db"),
  ]);
  h.tick(1.5);
  eq(h.loopRows(), 0, "rows in the loop zone");
});

check("an async request that offloads and RESUMES ends in the EVENT LOOP zone", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/async", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_view"),
    // offloaded DB call: worker thread, empty local stack -> parent_id null
    enter(T0 + 0.002, 2, null, "threadpool", "blocking_db_query"),
    // ...and back on the loop afterwards
    enter(T0 + 0.05, 3, 1, "event_loop", "after_the_db_call"),
    ev(T0 + 0.06, "request_end", { status: 200, duration_ms: 60 }),
  ]);
  h.tick(2);
  eq(h.loopRows(), 1, "rows in the loop zone");
});

check("order does not matter: offload seen BEFORE any loop frame", () => {
  // FastAPI's sync dependency resolves before the async endpoint runs.
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/dep", request_id: null }),
    enter(T0 + 0.001, 1, null, "threadpool", "get_db"),
    enter(T0 + 0.03, 2, null, "event_loop", "sync_dep"),
    ev(T0 + 0.05, "request_end", { status: 200, duration_ms: 50 }),
  ]);
  h.tick(2);
  eq(h.loopRows(), 1, "rows in the loop zone");
});

check("zone does not oscillate when offloads interleave", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/x", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "handler"),
    enter(T0 + 0.002, 2, null, "threadpool", "off1"),
    enter(T0 + 0.010, 3, 1, "event_loop", "mid"),
    enter(T0 + 0.020, 4, null, "threadpool", "off2"),
    ev(T0 + 0.030, "request_end", { status: 200, duration_ms: 30 }),
  ]);
  h.tick(2);
  eq(h.loopRows(), 1, "rows in the loop zone");
});

check("an offload leaves a DURABLE '⇢ pool' tag on the finished row", () => {
  // The row correctly stays in the loop zone, and the per-node stub vanishes
  // once the frame leaves the active call path — so without a row-level tag a
  // finished request shows no sign it ever used a worker thread.
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/v", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_view"),
    enter(T0 + 0.10, 2, 1, "threadpool", "blocking_db_query"),
    ev(T0 + 0.101, "offload_start", { node_id: 2 }),
    ev(T0 + 0.30, "offload_end", { node_id: 2 }),
    ev(T0 + 0.301, "call_exit", { node_id: 2 }),
    enter(T0 + 0.31, 3, 1, "event_loop", "after_db"),
    ev(T0 + 0.40, "call_exit", { node_id: 3 }),
    ev(T0 + 0.41, "call_exit", { node_id: 1 }),
    ev(T0 + 0.42, "request_end", { status: 200, duration_ms: 420 }),
  ]);
  h.tick(4);
  eq(h.loopRows(), 1, "row stays in the loop zone");
  if (!h.drawn().some((t) => t.startsWith("⇢ pool"))) {
    throw new Error("finished row shows no record of the offload");
  }
  if (!h.drawn().some((t) => t.includes("DONE"))) {
    throw new Error("expected the row to have finished");
  }
});

check("the row MOVES to THREADPOOL during the offload and back afterwards", () => {
  const h = harness();
  h.tick(1);
  // 1. async view running on the loop
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/v", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_view"),
  ]);
  h.tick(0.6);
  eq(h.loopRows(), 1, "before the offload: row is in the loop zone");

  // 2. DB call goes to a worker thread
  h.frame([
    enter(T0 + 0.10, 2, 1, "threadpool", "blocking_db_query"),
    ev(T0 + 0.101, "offload_start", { node_id: 2 }),
  ]);
  h.tick(0.8);
  eq(h.loopRows(), 0, "during the offload: row has moved to the threadpool zone");

  // 3. it returns, and execution resumes on the loop
  h.frame([
    ev(T0 + 0.30, "offload_end", { node_id: 2 }),
    ev(T0 + 0.301, "call_exit", { node_id: 2 }),
    enter(T0 + 0.31, 3, 1, "event_loop", "after_db"),
  ]);
  h.tick(0.8);
  eq(h.loopRows(), 1, "after the offload: row is back in the loop zone");

  // 4. finished — must settle at home, never stranded
  h.frame([
    ev(T0 + 0.40, "call_exit", { node_id: 3 }),
    ev(T0 + 0.41, "call_exit", { node_id: 1 }),
    ev(T0 + 0.42, "request_end", { status: 200, duration_ms: 420 }),
  ]);
  h.tick(2);
  eq(h.loopRows(), 1, "finished: row rests in the loop zone");
});

check("a dropped offload_end cannot strand a finished row", () => {
  // The bounded server buffer can shed events. If offload_end is lost, the
  // in-flight counter would stay above zero forever -- request_end clears it.
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/v", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_view"),
    enter(T0 + 0.10, 2, 1, "threadpool", "db"),
    ev(T0 + 0.101, "offload_start", { node_id: 2 }),
    // no offload_end -- dropped
    ev(T0 + 0.42, "request_end", { status: 200, duration_ms: 420 }),
  ]);
  h.tick(3);
  eq(h.loopRows(), 1, "finished row settles in the loop zone anyway");
});

check("a purely sync request stays in THREADPOOL across its offload", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/sync", request_id: null }),
    enter(T0 + 0.001, 1, null, "threadpool", "sync_view"),
    ev(T0 + 0.002, "offload_start", { node_id: 1 }),
    ev(T0 + 0.20, "offload_end", { node_id: 1 }),
    ev(T0 + 0.201, "call_exit", { node_id: 1 }),
    ev(T0 + 0.21, "request_end", { status: 200, duration_ms: 210 }),
  ]);
  h.tick(3);
  eq(h.loopRows(), 0, "never enters the loop zone");
});

check("STEP MODE shows the hand-off: one click out to the worker, one back", () => {
  // With a single request in flight there is no loop hand-off after the first
  // click, so a step used to drain straight through request_end -- applying
  // offload_start and offload_end together and hiding the whole trip.
  const h = harness();
  h.stepMode(true);
  h.tick(0.5);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/v", request_id: null }),
    enter(T0 + 0.001, 1, null, "event_loop", "async_view"),
    enter(T0 + 0.10, 2, 1, "threadpool", "blocking_db_query"),
    ev(T0 + 0.101, "offload_start", { node_id: 2 }),
    ev(T0 + 0.30, "offload_end", { node_id: 2 }),
    ev(T0 + 0.301, "call_exit", { node_id: 2 }),
    enter(T0 + 0.31, 3, 1, "event_loop", "after_db"),
    ev(T0 + 0.42, "request_end", { status: 200, duration_ms: 420 }),
  ]);
  h.tick(0.5);

  // Walk the request one checkpoint at a time and record where the row sits.
  const seen = [];
  for (let i = 0; i < 6; i++) {
    h.step();
    h.tick(0.2);
    const where = h.loopRows();
    if (where !== null) seen.push(where === 0 ? "pool" : "loop");
  }
  // It must visit the threadpool zone at some point...
  if (!seen.includes("pool")) {
    throw new Error("row never appeared in the threadpool zone: " + seen.join(","));
  }
  // ...and be back on the loop by the end.
  eq(seen[seen.length - 1], "loop", "row after the final step");
});

console.log(failures === 0 ? "\nall zone tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
