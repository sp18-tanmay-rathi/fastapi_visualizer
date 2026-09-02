// The chrome around the graph: panel tabs, the keyboard, the draggable divider.
//
// These are the parts with real behaviour rather than styling, so they are the
// parts worth pinning down.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadAll } = require("./_sources");

const T0 = 517342.5;
const FRAME_MS = 16.7;

function harness(viewH) {
  const VIEWH = viewH || 800;
  let clock = 0;
  const els = {};
  let texts = [];
  let placed = [];
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === "measureText") return () => ({ width: 10 });
      if (p === "fillText") return (s, x, y) => {
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
      tagName: id.indexOf("ld-") === 0 ? "INPUT" : "DIV",
      style: {}, innerHTML: "",
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, f) {
          const on = f === undefined ? !this._s.has(c) : !!f;
          if (on) this._s.add(c); else this._s.delete(c);
          return on;
        },
      },
      _h: {}, addEventListener(e, f) { this._h[e] = f; },
      _attrs: {},
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      focus() { doc.activeElement = this; }, blur() { doc.activeElement = null; }, select() {},
      setPointerCapture() {}, releasePointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      offsetHeight: 37, clientWidth: 1200, clientHeight: VIEWH,
      getContext: () => ctx, width: 1200, height: VIEWH,
    };
    return els[id];
  }
  const doc = {
    getElementById: el,
    querySelector: () => el("header"),
    activeElement: null,
    _keys: {},
    addEventListener(ev, fn) { this._keys[ev] = fn; },
  };
  let rafCb = null, ws = null;
  const sb = {
    document: doc,
    window: { addEventListener() {}, innerWidth: 1200, innerHeight: 837, devicePixelRatio: 2 },
    performance: { now: () => clock },
    requestAnimationFrame: (cb) => { rafCb = cb; },
    location: { protocol: "http:", host: "h", pathname: "/_viz/" },
    WebSocket: function () { ws = this; setTimeout(() => this.onopen && this.onopen(), 0); },
    setTimeout: (fn) => { fn(); return 0; },
    JSON, Math, console, String, Number, Array, Object, Map, Set, RegExp,
    isNaN, parseInt, parseFloat, Infinity,
  };
  sb.devicePixelRatio = 2;
  sb.self = sb;
  vm.createContext(sb);
  loadAll(vm, sb);
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ events: [
    { seq: 1, t: T0 - 60, kind: "pool_sample", trace_id: null, task_id: null, name: "tp",
      extra: { borrowed: 0, total: 40, queued: 0 } }] }) });

  return {
    el,
    doc,
    frame: (evs) => ws.onmessage({ data: JSON.stringify({ events: evs }) }),
    tick(seconds) {
      const n = Math.round((seconds * 1000) / FRAME_MS);
      for (let i = 0; i < n; i++) { clock += FRAME_MS; texts = []; placed = []; if (rafCb) rafCb(); }
    },
    has: (frag) => texts.some((t) => t.includes(frag)),
    placedText: (frag) => placed.find((e) => e.s.indexOf(frag) >= 0) || null,
    drawn: () => texts.slice(),
    tab: (which) => el(which === "guide" ? "tab-guide" : "tab-request").getAttribute("aria-selected"),
    clickTab(which) {
      const t = el(which === "guide" ? "tab-guide" : "tab-request");
      if (t._h.click) t._h.click({});
    },
    clickRow(frag) {
      const hit = placed.find((e) => e.s.indexOf(frag) >= 0);
      if (!hit) throw new Error("no drawn label containing " + JSON.stringify(frag));
      el("viz")._h.click({ clientX: hit.x + 2, clientY: hit.y });
    },
    clickEmpty() { el("viz")._h.click({ clientX: 900, clientY: 780 }); },
    key(k, opts) {
      const e = Object.assign({ key: k, preventDefault() {} }, opts || {});
      if (doc._keys.keydown) doc._keys.keydown(e);
    },
    canvasEvent(name, ev) { const c = el("viz"); if (c._h[name]) c._h[name](ev); },
    // Find the divider the way a user does: sweep for where the canvas offers
    // a resize cursor. Beats hardcoding a position that depends on row counts.
    findDivider() {
      const c = el("viz");
      for (let y = 20; y < 780; y += 2) {
        c.style.cursor = "";
        if (c._h.pointermove) c._h.pointermove({ offsetY: y, preventDefault() {} });
        if (c.style.cursor === "ns-resize") return y;
      }
      throw new Error("no draggable divider found anywhere on the canvas");
    },
  };
}

let seq = 10;
const TR = "dddddddddddddddd";
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

function oneRequest(h) {
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/async", request_id: null }),
    enter(T0 + 0.001, 1, null, "async_ep"),
    enter(T0 + 0.01, 2, 1, "db_fetch"),
  ]);
}

// --- tabs -----------------------------------------------------------------

check("the guide is the default tab, not the empty request pane", () => {
  const h = harness();
  h.tick(1);
  eq(h.tab("guide"), "true", "guide selected on load");
  eq(h.tab("request"), "false", "request selected on load");
  eq(h.el("request-empty").hidden, false, "the empty-state note is available");
});

check("clicking a row brings the Request tab forward", () => {
  const h = harness();
  h.tick(1);
  oneRequest(h);
  h.tick(0.4);
  h.clickRow("/async");
  eq(h.tab("request"), "true", "request tab after clicking a row");
  eq(h.tab("guide"), "false", "guide tab after clicking a row");
  eq(h.el("request-empty").hidden, true, "empty note hidden once a row is selected");
});

check("it switches back even after you manually returned to the guide", () => {
  const h = harness();
  h.tick(1);
  oneRequest(h);
  h.tick(0.4);
  h.clickRow("/async");
  h.clickTab("guide");
  eq(h.tab("guide"), "true", "manually back on the guide");
  h.tick(0.2);
  h.clickRow("/async");
  eq(h.tab("request"), "true", "a row click always wins");
});

check("deselecting hands the panel back to the guide", () => {
  const h = harness();
  h.tick(1);
  oneRequest(h);
  h.tick(0.4);
  h.clickRow("/async");
  eq(h.tab("request"), "true", "selected");
  h.clickEmpty();
  eq(h.tab("guide"), "true", "guide returns when nothing is selected");
});

// --- keyboard -------------------------------------------------------------

check("Space steps only when step mode is on", () => {
  const h = harness();
  h.tick(1);
  const btn = h.el("ld-step-btn");
  btn.disabled = true;              // step mode off -> button disabled
  let stepped = 0;
  const orig = btn._h.click;
  btn._h.click = () => { stepped++; if (orig) orig({}); };

  h.key(" ");
  eq(stepped, 0, "steps taken with step mode off");

  // turn step mode on the way the checkbox does
  const toggle = h.el("ld-step");
  toggle.checked = true;
  if (toggle._h.change) toggle._h.change({});
  eq(btn.disabled, false, "step button enabled once step mode is on");
});

check("Space is ignored while a field has focus", () => {
  const h = harness();
  h.tick(1);
  const toggle = h.el("ld-step");
  toggle.checked = true;
  if (toggle._h.change) toggle._h.change({});

  const filter = h.el("ld-filter");
  filter.tagName = "INPUT";
  h.doc.activeElement = filter;

  let prevented = false;
  h.key(" ", { preventDefault() { prevented = true; } });
  eq(prevented, false, "typing a space in the filter must not be stolen");
});

check("/ focuses the filter box", () => {
  const h = harness();
  h.tick(1);
  h.key("/");
  eq(h.doc.activeElement && h.doc.activeElement.id, "ld-filter", "focused element");
});

// --- divider --------------------------------------------------------------

function dragDividerTo(h, y) {
  const at = h.findDivider();
  h.canvasEvent("pointerdown", { offsetY: at, pointerId: 1, preventDefault() {} });
  h.canvasEvent("pointermove", { offsetY: y, pointerId: 1, preventDefault() {} });
  h.canvasEvent("pointerup", { pointerId: 1 });
  h.tick(0.3);
  return h.findDivider();
}

check("dragging the divider moves it and keeps it there", () => {
  const h = harness();
  h.tick(1);
  oneRequest(h);
  h.tick(0.4);
  const before = h.findDivider();
  const after = dragDividerTo(h, 300);
  if (Math.abs(after - 300) > 6)
    throw new Error(`divider went to ${after}, asked for 300`);
  if (after === before) throw new Error("divider did not move at all");
  // and it STAYS there across frames rather than snapping back to the
  // automatic proportion on the next render
  h.tick(1.5);
  const later = h.findDivider();
  if (Math.abs(later - after) > 2)
    throw new Error(`pinned divider drifted from ${after} to ${later}`);
});

// The zone floor. A fraction of a short window is still too small to be
// usable: at 26% the threadpool zone came out shorter than its own header and
// its first row drew on top of the header text.
// A SHORT window is the whole point of these two. On a tall one, 26% is still
// ~200px and nothing looks wrong; it is the laptop-height case where a
// fraction stops being enough room for a header plus a row.
const SHORT = 300;          // canvas height in CSS px
const ZONE_FLOOR = 46 + 64; // header + one collapsed row

check("the threadpool zone keeps its floor on a short window", () => {
  const h = harness(SHORT);
  h.tick(1);
  oneRequest(h);
  h.tick(0.4);
  const at = dragDividerTo(h, 5000);      // drag as far down as it will go
  const below = SHORT - at;
  if (below < ZONE_FLOOR)
    throw new Error(
      `only ${below}px left for the threadpool zone — its header plus one row ` +
      `needs ${ZONE_FLOOR}, so rows draw over the header`
    );
  if (!h.has("THREADPOOL"))
    throw new Error("the threadpool header stopped being drawn entirely");
});

check("the loop zone keeps its floor on a short window", () => {
  const h = harness(SHORT);
  h.tick(1);
  oneRequest(h);
  h.tick(0.4);
  const at = dragDividerTo(h, -5000);
  if (at < ZONE_FLOOR)
    throw new Error(`only ${at}px left for the loop zone, needs ${ZONE_FLOOR}`);
  if (!h.has("EVENT LOOP"))
    throw new Error("the loop header stopped being drawn entirely");
});

check("double-clicking the divider returns it to automatic", () => {
  const h = harness();
  h.tick(1);
  oneRequest(h);
  h.tick(0.4);
  const auto = h.findDivider();
  const pinned = dragDividerTo(h, 300);
  if (Math.abs(pinned - auto) < 10) throw new Error("precondition: the drag did nothing");

  h.canvasEvent("dblclick", { offsetY: pinned, preventDefault() {} });
  h.tick(0.3);
  const back = h.findDivider();
  if (Math.abs(back - auto) > 3)
    throw new Error(`double-click left it at ${back}, automatic is ${auto}`);
});

check("a click that grabbed the divider does not also select a row", () => {
  const h = harness();
  h.tick(1);
  oneRequest(h);
  h.tick(0.4);
  // click exactly on the divider — that gesture is a resize, not a selection
  const dy3 = h.findDivider();
  h.el("viz")._h.click({ clientX: 400, clientY: dy3 });
  eq(h.tab("guide"), "true", "resizing must not open the Request tab");
});

// --- per-call timing ------------------------------------------------------
//
// `sys.monitoring` emits suspend/resume for the frame that actually yields,
// never for its callers. So `elapsed - awaitMs` is the truth for a LEAF and a
// lie for a parent: on a real capture, an endpoint that held the loop for 80ms
// came out as 282ms because its child's park was invisible to it.

function treeWithAPark(h) {
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/mix", request_id: null }),
    enter(T0 + 0.000, 1, null, "mix"),
    enter(T0 + 0.001, 2, 1, "db_fetch"),
    ev(T0 + 0.002, "suspend", { node_id: 2, awaiting: "sleep" }),
    ev(T0 + 0.202, "resume", { node_id: 2 }),
    ev(T0 + 0.202, "call_exit", { node_id: 2 }),
    enter(T0 + 0.203, 3, 1, "spin"),
    ev(T0 + 0.283, "call_exit", { node_id: 3 }),
    ev(T0 + 0.284, "call_exit", { node_id: 1 }),
    ev(T0 + 0.285, "request_end", { status: 200, duration_ms: 285 }),
  ]);
}

check("an expanded row times each call", () => {
  const h = harness();
  h.tick(1);
  treeWithAPark(h);
  h.tick(0.6);
  h.clickRow("/mix");        // expands it
  h.tick(0.6);
  const drawn = h.drawn().join(" | ");
  if (!/\d+ms/.test(drawn))
    throw new Error("no per-call timing drawn on an expanded row: " + drawn);
});

check("a parked leaf reports how little of it was on the loop", () => {
  const h = harness();
  h.tick(1);
  treeWithAPark(h);
  h.tick(0.6);
  h.clickRow("/mix");
  h.tick(0.6);
  const parked = h.drawn().find((t) => /on loop/.test(t) && /·/.test(t));
  if (!parked)
    throw new Error("a leaf that parked did not report its loop share: " + h.drawn().join(" | "));
  // it parked for essentially all of its 200ms
  const m = parked.match(/·\s*(\d+)ms on loop/);
  if (!m) throw new Error("unparseable timing: " + parked);
  if (Number(m[1]) > 20) throw new Error("a frame that parked throughout claims " + m[1] + "ms on loop");
});

check("a frame with children makes NO loop claim", () => {
  const h = harness();
  h.tick(1);
  treeWithAPark(h);
  h.tick(0.6);
  h.clickRow("/mix");
  h.tick(0.6);
  // The root `mix` has children, so its own park record is incomplete and any
  // "on loop" figure for it would overstate. It must show elapsed only.
  const rootTiming = h.drawn().filter((t) => /^28[0-9]ms/.test(t) || /^29[0-9]ms/.test(t));
  rootTiming.forEach((t) => {
    if (/on loop/.test(t))
      throw new Error("a parent frame claimed loop occupancy it cannot prove: " + t);
  });
});

check("a collapsed row shows no per-call timing", () => {
  const h = harness();
  h.tick(1);
  treeWithAPark(h);
  h.tick(0.6);
  // never clicked, so never expanded
  if (h.drawn().some((t) => /on loop/.test(t)))
    throw new Error("collapsed rows should not carry per-call timing");
});

// --- the empty state ------------------------------------------------------
//
// Centred on the whole canvas it landed exactly on the divider: the line
// struck through the sentence and the drag grip sat on one of its words.

check("the empty state sits inside the loop band, clear of the divider", () => {
  const h = harness();
  h.tick(1.2);                       // idle: no requests at all
  const dy = h.findDivider();
  h.tick(0.3);
  const hint = h.placedText("No requests in flight");
  if (!hint) throw new Error("no empty state drawn: " + h.drawn().join(" | "));
  // it must clear the divider by more than half the card
  if (Math.abs(hint.y - dy) < 40)
    throw new Error(`empty state at y=${hint.y} sits on the divider at y=${dy}`);
  if (hint.y > dy)
    throw new Error("empty state drew below the divider, in the threadpool zone");
});

check("the empty state explains a filter that hides everything", () => {
  const h = harness();
  h.tick(1);
  h.frame([
    ev(T0, "request_start", { method: "GET", path: "/async", request_id: null }),
    enter(T0 + 0.001, 1, null, "async_ep"),
  ]);
  h.tick(0.4);
  const filter = h.el("ld-filter");
  filter.value = "path:/nothing-matches";
  if (filter._h.input) filter._h.input({});
  h.tick(0.4);
  if (!h.has("No rows match the filter"))
    throw new Error("a filter hiding every row should say so: " + h.drawn().join(" | "));
});

console.log(failures ? `\n${failures} FAILED` : "\nall chrome tests passed");
process.exit(failures ? 1 : 0);
