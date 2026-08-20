// Deterministic replay tests for dashboard.js's playback clock.
//
// dashboard.js is a single IIFE with no exports (deliberately — no build step,
// works offline), so instead of importing its internals we load the real file
// under a stubbed DOM and drive it the way a browser would: feed WebSocket
// frames, tick requestAnimationFrame against a fake clock, and observe the
// "#event-count" element that ingest() updates. That makes "did these events
// actually reach the graph?" assertable without a browser.
//
// Run: node tests/js/playback_test.js   (exit 0 = pass)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DASHBOARD = path.join(__dirname, "..", "..", "src", "fastapi_visualizer", "static", "dashboard.js");

// Server timestamps come from time.monotonic(), which is a large number
// (seconds since boot) — not a small one. That matters: the original bug was
// only visible because virtualT started at 0, i.e. ~500k seconds behind.
const T0 = 517342.5;
const FRAME_MS = 16.7; // ~60fps
const SPEED = 0.2; // dashboard default

function makeHarness() {
  let clock = 0;
  const els = {};
  const ctx = new Proxy(
    {},
    {
      get(t, p) {
        if (p === "measureText") return () => ({ width: 10 });
        return p in t ? t[p] : () => {};
      },
      set(t, p, v) {
        t[p] = v;
        return true;
      },
    }
  );

  function el(id) {
    if (!els[id]) {
      els[id] = {
        id,
        textContent: "",
        value: "",
        hidden: false,
        checked: false,
        disabled: false,
        style: {},
        classList: { add() {}, remove() {}, toggle() { return false; } },
        _handlers: {},
        addEventListener(ev, fn) { this._handlers[ev] = fn; },
        fire(ev) { if (this._handlers[ev]) this._handlers[ev]({ clientX: 0, clientY: 0 }); },
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
        offsetHeight: 37,
        clientWidth: 1200,
        clientHeight: 800,
        getContext: () => ctx,
        width: 1200,
        height: 800,
      };
    }
    return els[id];
  }

  let rafCb = null;
  let ws = null;
  const sandbox = {
    document: { getElementById: el, querySelector: () => el("header") },
    window: { addEventListener() {}, innerWidth: 1200, innerHeight: 837 },
    performance: { now: () => clock },
    requestAnimationFrame: (cb) => { rafCb = cb; },
    location: { protocol: "http:", host: "localhost", pathname: "/_viz/" },
    WebSocket: function () { ws = this; setTimeout(() => this.onopen && this.onopen(), 0); },
    setTimeout: (fn) => { fn(); return 0; },
    JSON, Math, console, String, Number, Array, Object, Map, Set, RegExp,
    isNaN, parseInt, parseFloat, Infinity,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(DASHBOARD, "utf8"), sandbox, { filename: DASHBOARD });

  if (!ws) throw new Error("dashboard.js did not open a WebSocket");
  ws.onopen();

  let seq = 10;
  return {
    el,
    // The FIRST frame is the on-connect backlog, which the dashboard drops by
    // design — so every test sends one to get into the real steady state.
    backlog() {
      ws.onmessage({
        data: JSON.stringify({
          events: [{ seq: 1, t: T0 - 60, kind: "pool_sample", trace_id: null, task_id: null, name: "tp", extra: { borrowed: 0, total: 40, queued: 0 } }],
        }),
      });
    },
    // One request's worth of events: 300ms of server time, 4 events.
    request(at, trace) {
      const evs = [];
      const push = (dt, kind, extra) =>
        evs.push({ seq: seq++, t: at + dt, kind, trace_id: trace, task_id: 1, name: "async_ep", extra });
      const node = seq;
      push(0.0, "request_start", { method: "GET", path: "/async", request_id: null });
      push(0.001, "call_enter", { node_id: node, parent_id: null, qualname: "async_ep", file: "demo.py", line: 39, is_async: true, execution: "event_loop" });
      push(0.2, "call_exit", { node_id: node });
      push(0.3, "request_end", { status: 200, duration_ms: 300 });
      ws.onmessage({ data: JSON.stringify({ events: evs }) });
      return evs.length;
    },
    tick(seconds) {
      const n = Math.round((seconds * 1000) / FRAME_MS);
      for (let i = 0; i < n; i++) {
        clock += FRAME_MS;
        if (rafCb) rafCb();
      }
    },
    ingested: () => Number(el("event-count").textContent) || 0,
  };
}

// --- assertions -----------------------------------------------------------

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  PASS  " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL  " + name + "\n        " + err.message);
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

// A 300ms burst at 0.2x needs ~1.5s of real time; allow 2.5s.
const PLAY_SECONDS = 2.5;

check("a request arriving while idle plays automatically (no step mode)", () => {
  const h = makeHarness();
  h.backlog();
  h.tick(1); // dashboard sitting open with no traffic — this is where the
  //            clock used to get poisoned to 0 and stall for ~100s
  const n = h.request(T0, "a".repeat(16));
  h.tick(PLAY_SECONDS);
  eq(h.ingested(), n, "events ingested");
});

check("an idle gap between two requests is collapsed", () => {
  const h = makeHarness();
  h.backlog();
  h.tick(1);
  const n1 = h.request(T0, "a".repeat(16));
  h.tick(PLAY_SECONDS);
  eq(h.ingested(), n1, "first request");
  h.tick(10); // 10s of nothing happening
  const n2 = h.request(T0 + 10, "b".repeat(16)); // ...and 10s later on the server
  h.tick(PLAY_SECONDS);
  eq(h.ingested(), n1 + n2, "second request after the gap");
});

check("playback starts promptly, not after a MAX_LAG creep", () => {
  const h = makeHarness();
  h.backlog();
  h.tick(1);
  h.request(T0, "a".repeat(16));
  h.tick(0.1); // a sixth of a second is plenty for the FIRST event
  if (h.ingested() === 0) throw new Error("nothing ingested within 100ms of arrival");
});

check("step mode freezes auto playback and advances per click", () => {
  const h = makeHarness();
  h.backlog();
  const toggle = h.el("ld-step");
  toggle.checked = true;
  toggle.fire("change");

  h.tick(1);
  const n = h.request(T0, "c".repeat(16));
  h.tick(3);
  eq(h.ingested(), 0, "ingested while step mode is on");

  const btn = h.el("ld-step-btn");
  for (let i = 0; i < 4; i++) btn.fire("click");
  eq(h.ingested(), n, "ingested after step clicks");
});

check("turning step mode off resumes automatic playback", () => {
  const h = makeHarness();
  h.backlog();
  const toggle = h.el("ld-step");
  toggle.checked = true;
  toggle.fire("change");
  h.tick(1);
  const n = h.request(T0, "d".repeat(16));
  h.tick(2);
  eq(h.ingested(), 0, "frozen while on");

  toggle.checked = false;
  toggle.fire("change");
  h.tick(PLAY_SECONDS);
  eq(h.ingested(), n, "played after switching step off");
});

console.log(failures === 0 ? "\nall playback tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
