// How does a row report a request that held the loop more than once?
//
// Two regressions live here:
//
//   1. `blockedMs` used to keep the MAX span and `blockedIn` the LAST frame, so
//      a request that blocked twice for 400ms each was reported as one 400ms
//      block — under-reporting by half and naming only one of the two frames.
//   2. The watchdog opens a span while the loop is still stuck (duration
//      unknown), and the timer closes the same stall afterwards with a
//      duration. Appending both listed ONE blocking call twice: once as "still
//      running" and once complete.
//
// The demo carries one endpoint per verdict and no duplicates, so neither case
// has an endpoint of its own — this is where they are pinned down.

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
  let strokes = [];
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === "measureText") return () => ({ width: 10 });
      if (p === "fillText") return (s, x, y) => {
        texts.push(String(s));
        placed.push({ s: String(s), x: Math.round(x), y: Math.round(y) });
      };
      // Rings are strokes, not text. Record the colour in force at the moment
      // of each stroke so a test can ask "was the hot ring painted?".
      if (p === "stroke" || p === "strokeRect") return () => { strokes.push(t.strokeStyle); };
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
      for (let i = 0; i < n; i++) { clock += FRAME_MS; texts = []; placed = []; strokes = []; if (rafCb) rafCb(); }
    },
    // the row tag, e.g. "⚙ held the loop 0.80s ×2"
    heldTag: () => texts.find((t) => t.indexOf("held the loop") >= 0) || null,
    stroked: (color) => strokes.indexOf(color) >= 0,
    // the inspector card body
    card: () => el("inspector-body").innerHTML,
    // click the row by the position of a label actually drawn on it
    clickRow(frag) {
      const hit = placed.find((e) => e.s.indexOf(frag) >= 0);
      if (!hit) throw new Error("no drawn label containing " + JSON.stringify(frag));
      const c = el("viz");
      if (c._h.click) c._h.click({ clientX: hit.x + 2, clientY: hit.y });
    },
  };
}

let seq = 10;
const TR = "bbbbbbbbbbbbbbbb";
const ev = (t, kind, extra) => ({ seq: seq++, t, kind, trace_id: TR, task_id: 1, name: "f", extra });
const enter = (t, node, parent, qual) =>
  ev(t, "call_enter", { node_id: node, parent_id: parent, qualname: qual,
                        file: "a.py", line: 1, is_async: true, execution: "event_loop" });

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  PASS  " + name); }
  catch (e) { failures++; console.log("  FAIL  " + name + "\n        " + e.message); }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); }
function contains(hay, needle, what) {
  if (String(hay).indexOf(needle) < 0)
    throw new Error(`${what}: expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(hay)}`);
}

check("two blocking calls report the SUM over two spans, not the worst one", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/twice", request_id: null }),
    enter(T0 + 0.001, 1, null, "twice_ep"),
    enter(T0 + 0.01, 2, 1, "blocking_step_one"),
    ev(T0 + 0.41, "call_exit", { node_id: 2 }),
    ev(T0 + 0.01, "loop_blocked", { node_id: 2, qualname: "blocking_step_one", duration_ms: 400 }),
    ev(T0 + 0.41, "loop_unblocked", { node_id: 2, qualname: "blocking_step_one", duration_ms: 400 }),
    enter(T0 + 0.42, 3, 1, "blocking_step_two"),
    ev(T0 + 0.82, "call_exit", { node_id: 3 }),
    ev(T0 + 0.42, "loop_blocked", { node_id: 3, qualname: "blocking_step_two", duration_ms: 400 }),
    ev(T0 + 0.82, "loop_unblocked", { node_id: 3, qualname: "blocking_step_two", duration_ms: 400 }),
    ev(T0 + 0.83, "call_exit", { node_id: 1 }),
    ev(T0 + 0.84, "request_end", { status: 200, duration_ms: 840 }),
  ]);
  h.tick(3);

  // 0.80s, not 0.40s — and the count makes the two spans explicit.
  eq(h.heldTag(), "⚙ held the loop 0.80s ×2", "row tag");
});

check("both blocking frames are named in the inspector card", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/twice", request_id: null }),
    enter(T0 + 0.001, 1, null, "twice_ep"),
    enter(T0 + 0.01, 2, 1, "blocking_step_one"),
    ev(T0 + 0.01, "loop_blocked", { node_id: 2, qualname: "blocking_step_one", duration_ms: 400 }),
    ev(T0 + 0.41, "loop_unblocked", { node_id: 2, qualname: "blocking_step_one", duration_ms: 400 }),
    ev(T0 + 0.41, "call_exit", { node_id: 2 }),
    enter(T0 + 0.42, 3, 1, "blocking_step_two"),
    ev(T0 + 0.42, "loop_blocked", { node_id: 3, qualname: "blocking_step_two", duration_ms: 400 }),
    ev(T0 + 0.82, "loop_unblocked", { node_id: 3, qualname: "blocking_step_two", duration_ms: 400 }),
    ev(T0 + 0.82, "call_exit", { node_id: 3 }),
    ev(T0 + 0.83, "call_exit", { node_id: 1 }),
    ev(T0 + 0.84, "request_end", { status: 200, duration_ms: 840 }),
  ]);
  h.tick(3);
  h.clickRow("/twice"); // select the only row

  const card = h.card();
  contains(card, "blocking_step_one", "inspector");
  contains(card, "blocking_step_two", "inspector");
});

check("a watchdog stall and the timer span for the SAME frame are one entry", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/blocking", request_id: null }),
    enter(T0 + 0.001, 1, null, "blocking_ep"),
    enter(T0 + 0.01, 2, 1, "blocking_call"),
    // watchdog first: the loop is stuck NOW, duration not yet known
    ev(T0 + 0.26, "loop_stalled", {
      node_id: 2, qualname: "blocking_call", file: "a.py", line: 1, elapsed_ms: 250,
      stack: [{ qualname: "blocking_call", file: "a.py", line: 1 }],
    }),
    // then the frame ends and the timer reports the same span with a duration
    ev(T0 + 0.51, "loop_unstalled", { qualname: "blocking_call", duration_ms: 500 }),
    ev(T0 + 0.01, "loop_blocked", { node_id: 2, qualname: "blocking_call", duration_ms: 500 }),
    ev(T0 + 0.51, "loop_unblocked", { node_id: 2, qualname: "blocking_call", duration_ms: 500 }),
    ev(T0 + 0.51, "call_exit", { node_id: 2 }),
    ev(T0 + 0.52, "call_exit", { node_id: 1 }),
    ev(T0 + 0.53, "request_end", { status: 200, duration_ms: 530 }),
  ]);
  h.tick(3);

  // ONE span, so no "×2" suffix — the same freeze must not be counted twice.
  eq(h.heldTag(), "⚙ held the loop 0.50s", "row tag");

  h.clickRow("/blocking");
  const card = h.card();
  if (/still running/.test(card))
    throw new Error("inspector still lists the finished span as running: " + card);
});

// The live "this frame is frozen RIGHT NOW" ring.
//
// `drawNode` decides it with `node.id === loopStalled.node_id`, but the
// loop_stalled handler built `loopStalled` without ever copying node_id across
// — so that test compared against `undefined` on every frame and the ring had
// never once been painted, despite the backend sending the id all along.
// T.badHot in dashboard.js. Kept as a literal on purpose: if the palette
// changes, this test should fail loudly and be re-baselined deliberately,
// rather than silently following whatever the theme now says.
const HOT_RING = "#ff7b73";

function frozenAt(h, extra) {
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/freeze", request_id: null }),
    enter(T0 + 0.001, 1, null, "freeze_ep"),
    enter(T0 + 0.01, 2, 1, "library_call"),
    ev(T0 + 0.30, "loop_stalled", Object.assign({
      qualname: "library_call",
      file: "a.py",
      line: 1,
      elapsed_ms: 260,
      stack: [{ qualname: "library_call", file: "a.py", line: 1 }],
    }, extra)),
  ]);
}

check("the frame frozen right now gets the hot ring", () => {
  const h = harness();
  h.tick(1);
  frozenAt(h, { node_id: 2 });
  h.tick(0.6);
  if (!h.stroked(HOT_RING))
    throw new Error("no hot ring painted for the stalled frame");
});

check("a stall with no node_id rings nothing rather than ringing node 0", () => {
  const h = harness();
  h.tick(1);
  frozenAt(h, {});           // backend could not attribute it to a frame
  h.tick(0.6);
  if (h.stroked(HOT_RING))
    throw new Error("an unattributed stall painted a ring on some node anyway");
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
