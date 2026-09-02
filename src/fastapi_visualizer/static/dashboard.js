// FastAPI Async Visualizer — live flow-graph renderer.
// Vanilla JS + canvas, no build step, no external dependencies, works offline.
//
// Mental model: ONE event loop, drawn as a vertical SPINE on the left edge of
// the canvas. Each in-flight HTTP request that is currently displayed gets
// its own horizontal ROW ("band") stacked down the spine — the row begins at
// the spine with the request-root node ("METHOD path") and its call tree
// flows rightward: tree depth maps to x (deeper calls sit further right),
// sibling calls stack with small vertical offsets within that row's band.
// Exactly one row "holds the loop" at a time (derived client-side, see
// loopHolder below); the rest are parked (suspended at an await) or off in
// the threadpool cluster (sync offload). This is meant to make the "single
// thread, one request runs at a time, everyone else waits its turn" model
// visually obvious: whichever row's connector to the spine is bright/thick,
// and whichever row the glowing spine marker sits next to, is the request
// currently running.
//
// To keep the picture legible with real traffic, only a capped number of
// concurrent requests are ever displayed as rows (see "max req" control,
// now "MAX ROWS KEPT"); a finished request stays on screen (greyed out) for
// inspection until either the cap evicts it (oldest finished row first) or
// the user hits "clear".
//
// Two more legibility measures on top of the above (added for ~10-way
// concurrency): (1) each row's call tree is COLLAPSED by default to just the
// active call-path chain (root -> ... -> the frame currently running/
// awaiting), with a "[+N]" badge for the rest of the tree — click a row to
// expand/collapse its full tree. (2) rows no longer split the spine into
// equal bands; each row gets its OWN height (small when collapsed, sized to
// its tree when expanded) stacked top-to-bottom in slot order, and the
// canvas scrolls vertically (mouse wheel) when the stack is taller than the
// viewport. The threadpool cluster stays pinned to a screen corner either way.

(function () {
  "use strict";

  var VIZ = window.VIZ;
  var T = VIZ.theme;
  var MONO = VIZ.theme.mono;
  var ARROW_HEAD = VIZ.theme.arrowHead;

  var POOL_DEFAULT_TOTAL = 40;

  // Layout constants (all in unrotated/unscaled canvas px; each row computes
  // its own scale factor to fit its call tree into its band — see drawBranch).
  var NODE_W = 140;
  var NODE_H = 32;
  // Depth spacing must leave a visible SHAFT between boxes, not just room for
  // the head. At 150 against a 140-wide node the gap was 10px and the
  // arrowhead alone is 7 of them, so connected boxes read as touching.
  var NODE_SPACING_X = 184; // px per tree-depth level (deeper = further right)
  // Slot PITCH, not gap: at 40 against a 32px node the space between two
  // stacked siblings was 8px, which is not enough to hang a timing line under
  // a box without it landing on the sibling below.
  var SIBLING_GAP = 58; // baseline px between sibling slots within a row band
  var MARGIN = 20; // right-edge margin reserved so trees don't run off-canvas
  var SPINE_X = 70; // x of the vertical event-loop spine
  var ROOT_X = SPINE_X + 90; // x where each row's request-root node sits
  var ROW_BAND_FILL = 0.8; // fraction of a row's band height siblings may use
  var MIN_SCALE = 0.35;

  // Per-row sizing (see "variable-height row stacking" in render()/layoutRows()).
  var ROW_COLLAPSED_H = 64; // collapsed row: just a chain, always this tall
  var ROW_EXPANDED_MIN = 180; // expanded row: never smaller than this
  var ROW_EXPANDED_MAX_FRAC = 0.6; // ...nor taller than this fraction of the viewport
  var ROW_GAP = 8; // breathing room between stacked rows
  var WORK_ROW_H = 52; // a live offloaded-call entry in the THREADPOOL zone

  // Two-zone layout (task 5): the canvas splits into a top EVENT LOOP zone
  // (async requests, one-runs-at-a-time) and a bottom THREADPOOL zone (sync
  // offloaded requests, real parallelism). Each zone has its own spine,
  // header, row stack and scroll. The divider sits proportionally to how many
  // rows each zone holds, clamped so both headers always stay visible.
  var ZONE_TOP = 8; // top margin above the loop zone
  var ZONE_BOTTOM_MARGIN = 8; // bottom margin below the pool zone
  var ZONE_HEADER_H = 46; // header strip (label + counts / pool grid) per zone
  var ZONE_DIV_GAP = 7; // half-gap around the divider line
  var ZONE_MIN_FRAC = 0.26; // neither zone shrinks below this fraction...
  var ZONE_MAX_FRAC = 0.74;
  // ...but a fraction of a short window is still too small to be usable. At
  // 26% of a laptop screen the threadpool zone came out shorter than its own
  // header, so its first row drew on top of the header text. The real floor is
  // in pixels: a zone must fit its header plus one collapsed row.
  var ZONE_MIN_PX = 46 /* ZONE_HEADER_H */ + 64 /* ROW_COLLAPSED_H */ + 8;

  // Loop-holder honesty (task 4): if the holder produced no in-root event for
  // this many SERVER seconds (playback time), the loop is presumed to be
  // running untraced code (stdlib / a DB driver / an HTTP client) rather than
  // the last in-root frame — so we show it dimmed as "untraced" instead of a
  // confident bright glow.
  var UNTRACED_AFTER = 0.15;

  // Blocking flash (task 3) is inherently RETROSPECTIVE: no event fires while
  // the loop is frozen, so loop_blocked (stamped at the span start) and
  // loop_unblocked (span end) only arrive together at the span's end and get
  // applied in the same drain — making the red flash instant/invisible.
  // Instead we light the flash for a fixed REAL-TIME window on ingest of
  // loop_blocked (scaled a bit by the block length, clamped), independent of
  // the playback clock, so it's clearly visible in both live and step mode.
  var BLOCK_FLASH_MIN_MS = 900;
  var BLOCK_FLASH_MAX_MS = 3000;

  // Trace ids are 16 hex chars (identity.py widened them from 6 so they don't
  // collide under load); a row tag shows this many characters, the inspector
  // shows the full id.
  var SHORT_ID_LEN = 6;

  // Requests slower than this (ms) get a highlighted duration tag and match the
  // `slow:true` filter. Header control, frontend-only: duration comes from
  // request_end, so changing the threshold needs no server round trip.
  var SLOW_REQ_MS = 500;

  var canvas = document.getElementById("viz");
  var ctx = canvas.getContext("2d");
  // Viewport in CSS px. Everything that lays out or draws uses these, never
  // VW/height, which are now the DPR-scaled backing store.
  var VW = 0;
  var VH = 0;
  var statusEl = document.getElementById("status");
  var statusTextEl = document.getElementById("status-text");
  var eventCountEl = document.getElementById("event-count");
  var alertsEl = document.getElementById("alerts");
  var capWarnEl = document.getElementById("cap-warn");
  var capCountEl = document.getElementById("cap-count");
  var dropWarnEl = document.getElementById("drop-warn");
  var dropCountEl = document.getElementById("drop-count");
  var multiWorkerWarnEl = document.getElementById("multi-worker-warn");

  // The alert strip only occupies space when it has something to say. It sits
  // OUTSIDE the header for a reason: warnings used to live in the header's
  // flex row, so raising one shoved every control sideways. Now the canvas
  // gets a little shorter and the controls do not move at all.
  function syncAlerts() {
    if (!alertsEl) return;
    if (capWarnEl) {
      capWarnEl.hidden = !hiddenByCap;
      if (capCountEl) capCountEl.textContent = String(hiddenByCap || 0);
    }
    var any =
      (dropWarnEl && !dropWarnEl.hidden) ||
      (capWarnEl && !capWarnEl.hidden) ||
      (multiWorkerWarnEl && !multiWorkerWarnEl.hidden);
    alertsEl.classList.toggle("on", !!any);
    // The canvas box changed height, so the backing store has to follow.
    resize();
  }
  var workerPidEl = document.getElementById("worker-pid");

  var eventCount = 0;

  // --- Dropped-event detection (see events.py/collector.py seq) ---------
  // Every event carries a process-wide monotonic `seq`. In RECEIPT order the
  // seq should increase by exactly 1; a larger jump means the bounded server
  // buffer shed events in between, so the trace we're reconstructing may be
  // missing structural events (a call_enter without its call_exit, etc.).
  // Surface that instead of silently drawing an impossible state.
  var lastSeq = null; // last seq seen in receipt order (null until first live event)
  var droppedCount = 0;

  function noteSeq(seq) {
    if (typeof seq !== "number") return;
    if (lastSeq !== null && seq > lastSeq + 1) {
      droppedCount += seq - lastSeq - 1;
      if (dropCountEl) dropCountEl.textContent = String(droppedCount);
      if (dropWarnEl) dropWarnEl.hidden = false;
      syncAlerts();
    }
    if (lastSeq === null || seq > lastSeq) lastSeq = seq;
  }

  // --- Time tracking -------------------------------------------------
  // Event timestamps (`t`) come from the server's monotonic clock, which
  // does not tick locally between WS frames. Remember the last known server
  // time alongside the local performance.now() it arrived at, and
  // extrapolate "now" from local elapsed time until the next frame lands.
  var lastServerT = 0;
  var lastLocalMs = performance.now();

  function nowT() {
    return lastServerT + (performance.now() - lastLocalMs) / 1000;
  }

  function noteServerT(t) {
    if (t > lastServerT) {
      lastServerT = t;
      lastLocalMs = performance.now();
    }
  }

  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  // --- Graph state -----------------------------------------------------
  //
  // branches: trace_id -> {
  //   traceId, method, path, hue, seq (creation order, see nextSeq below),
  //   rootNode:  synthetic node labeled "METHOD path" (depth 0, drawn like
  //              any other node, edge goes straight to the spine),
  //   nodesById: node_id -> node (mirrors the backend's call-tree),
  //   stack:     node_id[] mirroring the backend's per-task call stack —
  //              its top is "the frame currently executing" for this trace,
  //   done, doneAt: set on request_end. Finished branches are NOT faded or
  //              auto-deleted — they persist at full opacity (greyed "done"
  //              node styling) until the row cap evicts them or "clear" is
  //              hit; see getOrCreateBranch()'s eviction logic and the
  //              #ld-clear handler near the bottom of this file.
  //   expanded:  false = show only the active-path chain (default); true =
  //              show the full tree. Toggled by clicking the row.
  // }
  //
  // node: { id, parent_id, qualname, file, line, is_async,
  //         state: "running"|"suspended"|"done", offloaded: bool, children: [] }
  var branches = new Map();

  // Incrementing counter handed out as `seq` to each branch at creation —
  // used purely to order rows in stable ARRIVAL order (see layoutRows()).
  // This replaced the old fixed-slot model: since done branches no longer
  // free a slot on a timer, "row index" can't be a reusable small int
  // anymore, so we just stack rows in the order traces first appeared.
  var nextSeq = 0;

  // Which trace_id currently "holds the loop". Derived purely from the event
  // stream: call_enter/resume grant it, suspend (if it belonged to the
  // holder) releases it. Only one trace can hold it at a time, matching the
  // single-threaded asyncio event loop this is visualizing.
  var loopHolder = null;


  // Request selected for the inspector panel (trace_id), or null. Rendered as
  // a DOM overlay rather than on the canvas so the trace id is selectable text.
  var selectedTrace = null;
  var lastInspectorPaint = 0;

  // Parsed row filter (header text input). Purely a DISPLAY filter — it never
  // affects which traces are admitted as rows (see getOrCreateBranch).
  var filterTerms = [];

  // Qualname under the cursor, for cross-request highlighting. Derived at the
  // top of render() from the PREVIOUS frame's hoverRects (one frame of lag,
  // imperceptible) so drawNode needs no second layout pass.
  var hoverQual = null;

  // Offloaded calls executing on a worker thread RIGHT NOW, keyed
  // "traceId:nodeId". A request that awaits run_in_threadpool / sync_to_async
  // does not itself move to a worker: its coroutine stays suspended on the
  // loop while a *separate function* runs on the worker. So the work is
  // tracked here and rendered in the THREADPOOL zone as its own entry, while
  // the request keeps its row in the EVENT LOOP zone.
  var activeOffloads = new Map();

  // The loop is NOT RESPONDING right now, as reported by the watchdog thread
  // (see watchdog.py), or null. Unlike loop_blocked — which is retrospective and
  // arrives only once the span is over, so it needs a timed flash — this is a
  // live state with a real start and end, so it is simply held until
  // loop_unstalled arrives. { qualname, deepest, stack, sinceT, traceId }
  var loopStalled = null;

  // Latest threadpool sample.
  var pool = { borrowed: 0, total: POOL_DEFAULT_TOTAL, queued: 0 };

  // Set true while drawing rows in the THREADPOOL zone: the whole zone already
  // means "on a worker thread", so the per-node "⇢ pool" stub is redundant
  // noise there and is suppressed.
  var poolZoneDraw = false;

  // --- Request cap / MAX ROWS KEPT -------------------------------------
  // Only up to MAX_REQ requests are KEPT on screen at once (header "max req"
  // control, default 20 — "max rows kept", since finished rows no longer free
  // themselves on a timer). When a brand-new trace shows up at the cap (see
  // getOrCreateBranch): the OLDEST (lowest seq) branch that is already `done`
  // is evicted to make room. If every kept branch is still live/in-flight,
  // there's no done row to sacrifice, so THIS event is dropped — but the trace
  // is NOT permanently blacklisted: its next event retries admission, so as
  // soon as one of the live rows finishes it gets a slot and appears. (An
  // earlier version added it to a sticky hidden set and dropped it forever,
  // which meant an over-cap request in a simultaneous burst never showed even
  // after the others completed.)
  var MAX_REQ = 20;

  // A trace can block the loop while still OVER the row cap (not yet admitted,
  // so its branch doesn't exist). Remember that here (traceId -> worst
  // blockedMs) so the durable "🔥 blocked" tag is applied when the trace is
  // finally admitted, instead of the blocking fact being lost.
  var blockedBefore = new Map();

  // Requests the row cap turned away, so it can be said out loud.
  //
  // A plain counter, not a set: a trace has exactly one request_start, and
  // that is now the only event that can create a row, so it cannot be
  // double-counted. Nothing unbounded to grow over a long session.
  var hiddenByCap = 0;

  // --- Slow-motion playback -----------------------------------------
  // Requests finish in milliseconds, so applying events the instant they
  // arrive makes branches flash and vanish. Instead we BUFFER incoming
  // events and release them on a virtual clock that advances at SPEED×
  // real time (SPEED < 1 = slow motion). `virtualT` is the server-time we
  // have "played up to"; events are ingested only once virtualT reaches
  // their timestamp, so the suspend/resume handoffs unfold watchably.
  //
  // STEP MODE freezes this virtual clock entirely (advancePlayback becomes a
  // no-op besides keeping lastFrameMs fresh) and instead lets the user drain
  // the buffer one loop hand-off at a time via the "▶ step" button — see
  // doStep() below.
  var SPEED = 0.2; // 0.05..1.0, driven by the header slider
  var pending = []; // buffered events, ascending t
  var virtualT = null; // server-time played up to (null until first event)
  var maxSeenT = 0; // newest server-time buffered so far
  var lastFrameMs = performance.now();
  var MAX_LAG = 20; // cap how far virtualT may trail newest (server seconds)
  var stepMode = false; // true = auto-playback paused, driven by ▶ step clicks

  // On connect the server sends a BACKLOG snapshot (up to 5000 past events).
  // Replaying that would (a) flash long-finished requests and (b) let stale,
  // possibly-incomplete traces grab the limited row slots and never free them,
  // starving newly-fired requests. So we DROP the backlog and animate only
  // events newer than the live edge at connect time.
  var sawFirstFrame = false;
  var connectBaselineT = -Infinity; // ignore events at/older than this

  function bufferEvents(events) {
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.t <= connectBaselineT) continue; // stale backlog / pre-connect
      pending.push(ev);
      if (ev.t > maxSeenT) maxSeenT = ev.t;
    }
  }

  // Advance the virtual clock by the real frame delta × SPEED and drain any
  // buffered events whose timestamp it has now reached. In step mode this is
  // a no-op (the clock only moves via doStep()), but we still refresh
  // lastFrameMs so a huge stale `dt` doesn't cause a jump when step mode is
  // switched back off.
  function advancePlayback() {
    var nowMs = performance.now();
    var dt = (nowMs - lastFrameMs) / 1000;
    lastFrameMs = nowMs;

    if (stepMode) return;

    // Nothing buffered: leave the clock alone. It must NOT be seeded here —
    // render() runs from page load, so this branch is reached long before any
    // event exists, when maxSeenT is still 0. The old code set virtualT = 0
    // then, which made it non-null and permanently skipped the initialization
    // below; the clock then sat ~MAX_LAG behind the first burst and had to
    // creep 20 server-seconds at SPEED (100s of real time at 0.2x) before a
    // single event appeared. Auto-playback looked completely dead, and step
    // mode "worked" only because doStep() ignores this clock.
    if (pending.length === 0) return;

    // Jump the clock to the oldest buffered event whenever it is behind it.
    // Nothing exists between the two, so playing that stretch out in real time
    // would be dead waiting — this is what collapses both the initial gap (page
    // open, no traffic yet) and every idle gap BETWEEN bursts. Under continuous
    // load virtualT is already past pending[0].t, so this is a no-op there.
    if (virtualT === null || virtualT < pending[0].t) {
      virtualT = pending[0].t;
    }
    virtualT += dt * SPEED;
    if (maxSeenT - virtualT > MAX_LAG) virtualT = maxSeenT - MAX_LAG;

    var i = 0;
    while (i < pending.length && pending[i].t <= virtualT) i++;
    if (i > 0) {
      ingest(pending.slice(0, i));
      pending = pending.slice(i);
    }
  }

  // Drain buffered events in order until the next CHECKPOINT: either the loop
  // hands off to a new holder (async detail), OR a request finishes
  // (request_end). A suspend that merely clears loopHolder to null is not a
  // stop point — we drain through it until a real new holder takes over.
  // Including request_end matters for sync/threadpool traffic, which never
  // sets loopHolder: without it a step would drain the whole buffer at once
  // and then look frozen; with it, each click completes one request. If the
  // buffer runs dry first, we stop there (apply what's there).
  function doStep() {
    var before = loopHolder;
    var applied = 0;
    while (applied < pending.length) {
      var ev = pending[applied];
      ingest([ev]);
      applied++;
      virtualT = ev.t;
      // A step advances to the next CHECKPOINT, defined as either:
      //  - a LOOP hand-off: the loop passed to a new async request, or
      //  - a REQUEST finishing (request_end).
      // Sync/threadpool work never touches loopHolder (it isn't ON the loop),
      // so hand-offs never happen for pure sync traffic — without the
      // request_end checkpoint a step would drain the whole buffer at once and
      // then look frozen. With it, each click visibly completes one request.
      // Offload boundaries are checkpoints too. With one request in flight
      // there is no loop hand-off after the first click, so a step drained
      // straight through request_end and applied offload_start and
      // offload_end in ONE batch — the worker entry appeared and vanished
      // within a single ingest, i.e. invisibly.
      if (loopHolder !== before && loopHolder !== null) break;
      if (ev.kind === "offload_start" || ev.kind === "offload_end") break;
      if (ev.kind === "request_end") break;
    }
    pending = pending.slice(applied);
  }

  // Returns the branch for traceId, creating it on first sight. If we're at
  // the row cap and no room can be made (see eviction below), the trace is
  // marked hidden and null is returned — callers must treat null as "drop
  // this event".
  function getOrCreateBranch(traceId) {
    var b = branches.get(traceId);
    if (b) return b;

    // At cap: evict the OLDEST done branch (lowest seq) to make room. If
    // nothing kept is done (all still in-flight), there's no safe row to give
    // up — drop THIS event and return null. We do NOT blacklist the trace, so
    // its next event retries and it appears the moment a row finishes.
    if (branches.size >= MAX_REQ) {
      var evictId = null;
      var evictSeq = Infinity;
      branches.forEach(function (existing, id) {
        if (existing.done && existing.seq < evictSeq) {
          evictSeq = existing.seq;
          evictId = id;
        }
      });
      if (evictId !== null) {
        branches.delete(evictId);
      } else {
        return null;
      }
    }

    b = {
      traceId: traceId,
      method: "?",
      path: "?",
      hue: hashHue(traceId),
      seq: nextSeq++, // stable creation/arrival order — see nextSeq comment above
      nodesById: new Map(),
      stack: [],
      done: false,
      doneAt: 0,
      expanded: false,
      // "loop" (async, runs on the event loop) until the request-root frame's
      // call_enter proves it's "pool" (sync, offloaded to a worker thread).
      // Determines which zone the row lives in (task 5).
      // Which zone the row lives in — fixed by where the request's HANDLER
      // runs, and never changed afterwards. See updateZone().
      zone: "loop",
      sawLoopFrame: false,
      sawPoolFrame: false,
      // Offloads: how many are running right now (drives the WORKER state),
      // and a durable record for the finished row.
      liveOffloads: 0,
      offloadCount: 0,
      offloadMs: 0,
      _offloadStartT: new Map(),
      // Server-time of the most recent in-root event for this trace; used to
      // decide when a loop holder has gone "untraced" (task 4).
      lastEventT: 0,
      // Set once this request has EVER blocked the loop (a loop_blocked span);
      // persists through DONE so the row is durably tagged "🔥 blocked", not
      // just flashed for the moment. blockedMs = longest such span, for the tag.
      blocked: false,
      blockedMs: 0,
      // WHICH frame held the loop. The node itself drops off the collapsed
      // call-path as soon as it returns, so without remembering the name the
      // finished row can only say how long, never where.
      // Every span this request spent holding the loop. Keeping only the
      // worst one under-reported a handler with two blocking calls by half,
      // and naming only the last one hid the first entirely.
      blockSpans: [],

      stalled: false, // the loop is frozen inside THIS request right now
      // Categories of forbidden wait this request made on the loop thread
      // (file, socket, dns, database, subprocess, http). Recorded regardless
      // of how fast the call was — that is the whole point of detecting it by
      // identity rather than by duration.
      ioCalls: new Set(),
      ioDetails: [],
      // --- Request outcome + inspector data (task 14) ---
      shortId: traceId.slice(0, SHORT_ID_LEN),
      startT: 0, // server-time of request_start (duration fallback)
      status: null, // HTTP status, from request_end.extra
      durationMs: null,
      error: null, // exception class name, if the app raised
      requestId: null, // inbound X-Request-ID, when the client sent one
      taskIds: new Set(), // distinct asyncio tasks seen under this trace
      suspendCount: 0,
      blockCount: 0,
    };
    b.rootNode = {
      id: "root:" + traceId,
      qualname: "? ?",
      state: "running",
      children: [],
      isRoot: true,
    };
    // Carry over blocking recorded before this trace could be admitted.
    var pre = blockedBefore.get(traceId);
    if (pre) {
      b.blocked = true;
      b.blockedMs = pre.ms;
      b.blockCount = pre.count;
      b.blockSpans = pre.spans;
      blockedBefore.delete(traceId);
    }
    branches.set(traceId, b);
    return b;
  }

  // A request's zone is decided by where its HANDLER runs, and never changes.
  //
  //   any traced frame ran on the event loop  -> EVENT LOOP, for its whole life
  //   none ever did                           -> THREADPOOL (a sync handler)
  //
  // Measured basis: `await run_in_threadpool(f)` leaves the request's coroutine
  // SUSPENDED on the loop — its own frames only ever execute on the loop
  // thread, and the loop stays as free as it is during `await asyncio.sleep()`
  // (55 other callbacks served in 300ms, either way). Only `f` runs on a
  // worker. So the request has not moved, and its row must not move; the
  // worker's activity is shown separately (see activeOffloads).
  //
  // The predecessor keyed off `parent_id == null`, assuming only a request root
  // is parentless. False: a worker thread starts with an empty stack, so the
  // first frame offloaded onto it also reported parent_id null and looked like
  // a root — which is how an async request that offloaded a DB call got
  // stranded in THREADPOOL for the rest of its life.
  function updateZone(b) {
    b.zone = !b.sawLoopFrame && b.sawPoolFrame ? "pool" : "loop";
  }

  // --- Event ingestion ---------------------------------------------------
  //
  // This is the "tree-build" logic: call_enter attaches a new node under its
  // parent (parent_id -> nodesById lookup, or the branch's synthetic request
  // root when parent_id is null) and pushes the node onto the branch's call
  // stack; call_exit pops it back off. The resulting `children` arrays are
  // exactly the call tree — layout later just walks them, no rebuilding.
  function ingest(events) {
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      noteServerT(ev.t);
      var extra = ev.extra || {};
      var traceId = ev.trace_id;

      if (ev.kind === "pool_sample") {
        pool.borrowed = extra.borrowed || 0;
        pool.total = extra.total || POOL_DEFAULT_TOTAL;
        pool.queued = extra.queued || 0;
        continue;
      }

      if (!traceId) continue; // every other kind is scoped to a request

      if (ev.kind === "request_start") {
        var b0 = getOrCreateBranch(traceId);
        if (!b0) {
          // No room, and nothing finished to evict. This request will not be
          // shown at all — see the call_enter handler for why that is better
          // than showing it late — so say how many are being withheld.
          hiddenByCap++;
          syncAlerts();
          continue;
        }
        b0.method = extra.method || "?";
        b0.path = extra.path || "?";
        b0.rootNode.qualname = b0.method + " " + b0.path;
        b0.startT = ev.t;
        if (extra.request_id) b0.requestId = extra.request_id;
        continue;
      }

      if (ev.kind === "request_end") {
        var b1 = branches.get(traceId);
        if (b1) {
          b1.done = true;
          b1.doneAt = ev.t;
          // Outcome (task 14): the backend stamps status/duration_ms on
          // request_end. Fall back to the timestamp delta when they're absent
          // (older server, or request_start was dropped so startT is 0).
          if (extra.status != null) b1.status = extra.status;
          if (extra.duration_ms != null) b1.durationMs = extra.duration_ms;
          else if (b1.startT) b1.durationMs = Math.round((ev.t - b1.startT) * 1000);
          if (extra.error) b1.error = extra.error;
          // A dropped offload_end would otherwise leave this request looking
          // forever busy on a worker. A finished request is on no worker.
          b1.stalled = false;
          b1.liveOffloads = 0;
          b1._offloadStartT.clear();
          activeOffloads.forEach(function (w, k) {
            if (w.traceId === traceId) activeOffloads.delete(k);
          });
          // Grey out the request-root node too, so a finished branch reads
          // as done at a glance (persists on screen — see note above).
          b1.rootNode.state = "done";
        }
        continue;
      }

      if (ev.kind === "call_enter") {
        // A row is created ONLY by request_start. This used to create one too,
        // which is how a request refused at the cap still turned up later:
        // whichever event arrived after a slot freed built the row, halfway
        // through the request's life.
        //
        // That row was wrong in two ways at once. It appeared to START late,
        // so fifty requests that ran simultaneously rendered as a staggered
        // trickle — the exact opposite of what this tool exists to show. And
        // every call_enter that arrived while it was refused had been dropped,
        // so its tree was missing frames and the request looked like it did
        // less work than it did.
        //
        // A row is now complete or absent, never partly-invented. The cost:
        // requests already in flight when the dashboard connects never appear,
        // because their request_start predates the connection and the
        // collector does not replay. Open the page first, as the README says.
        var b2 = branches.get(traceId);
        if (!b2) continue;
        b2.lastEventT = ev.t;
        // One request can span several asyncio tasks (asyncio.create_task
        // children inherit the trace id); the inspector reports how many.
        if (ev.task_id != null) b2.taskIds.add(ev.task_id);
        // Classify the row's zone from its request-root frame (parent_id null):
        // the backend stamps execution = "threadpool" when the frame runs on a
        // worker thread (sync def), "event_loop" otherwise (async).
        if (extra.execution === "event_loop") b2.sawLoopFrame = true;
        else if (extra.execution === "threadpool") b2.sawPoolFrame = true;
        updateZone(b2);
        var parent =
          extra.parent_id == null
            ? b2.rootNode
            : b2.nodesById.get(extra.parent_id) || b2.rootNode;
        var node = {
          id: extra.node_id,
          parent_id: extra.parent_id,
          qualname: extra.qualname || ev.name || "?",
          file: extra.file,
          line: extra.line,
          is_async: !!extra.is_async,
          execution: extra.execution || "event_loop",
          state: "running",
          offloaded: false,
          children: [],
          // Per-call timing. Every ingredient is already in the stream — each
          // of call_enter / call_exit / suspend / resume carries `ev.t` — so
          // this costs nothing on the wire.
          startT: ev.t,
          endT: null,
          awaitMs: 0,       // time this frame spent parked at an await
          _parkedAt: null,  // when the current park began, if it is parked
        };
        b2.nodesById.set(extra.node_id, node);
        parent.children.push(node);
        b2.stack.push(extra.node_id);
        // Entering a frame means this trace is running — but the loop holder
        // must be judged per FRAME, not per request. A loop-zone request can
        // contain threadpool frames (it awaited run_in_threadpool), and while
        // that runs the request is PARKED: its coroutine is suspended and the
        // loop is free for someone else. Keying off the branch's zone here
        // would let a parked request claim the loop it is not on.
        if (extra.execution === "event_loop") loopHolder = traceId;
        continue;
      }

      if (ev.kind === "call_exit") {
        var b3 = branches.get(traceId);
        if (!b3) continue;
        b3.lastEventT = ev.t;
        var n3 = b3.nodesById.get(extra.node_id);
        if (n3) {
          n3.state = "done";
          n3.endT = ev.t;
          // A frame can return straight out of a park (its await resolved and
          // the coroutine finished); close the open interval or that time is
          // silently lost from the total.
          if (n3._parkedAt != null) {
            n3.awaitMs += Math.max(0, (ev.t - n3._parkedAt) * 1000);
            n3._parkedAt = null;
          }
          if (n3.awaiting) n3.awaitDone = true; // frame returned; its await resolved
        }
        var idx = b3.stack.lastIndexOf(extra.node_id);
        if (idx >= 0) b3.stack.splice(idx, 1);
        continue;
      }

      if (ev.kind === "suspend") {
        var b4 = branches.get(traceId);
        if (!b4) continue;
        b4.lastEventT = ev.t;
        b4.suspendCount++;
        var n4 = b4.nodesById.get(extra.node_id);
        if (n4) {
          n4.state = "suspended";
          n4.awaiting = extra.awaiting;
          n4.awaitDone = false; // currently blocked on this await
          if (n4._parkedAt == null) n4._parkedAt = ev.t;
        }
        // Yielding the loop only releases the loop if this trace was the one
        // holding it (it may be releasing a frame deeper than the holder's
        // current top-of-stack, in edge cases — still safe to clear).
        if (loopHolder === traceId) loopHolder = null;
        continue;
      }

      if (ev.kind === "resume") {
        var b5 = branches.get(traceId);
        if (!b5) continue;
        b5.lastEventT = ev.t;
        var n5 = b5.nodesById.get(extra.node_id);
        if (n5) {
          n5.state = "running";
          if (n5._parkedAt != null) {
            n5.awaitMs += Math.max(0, (ev.t - n5._parkedAt) * 1000);
            n5._parkedAt = null;
          }
          if (n5.awaiting) n5.awaitDone = true; // the await it was blocked on resolved
        }
        // Same per-frame rule as call_enter. `resume` carries no execution
        // tag, so consult the node recorded at call_enter; default to treating
        // it as loop work when the node is unknown (an event was shed).
        if (!n5 || n5.execution === "event_loop") loopHolder = traceId;
        continue;
      }

      if (ev.kind === "blocking_call") {
        var bcb = branches.get(traceId);
        if (bcb) {
          bcb.ioCalls.add(extra.category || "io");
          if (bcb.ioDetails.length < 12) {
            bcb.ioDetails.push({
              category: extra.category || "io",
              detail: extra.detail || "",
              qualname: extra.qualname || null,
            });
          }
        }
        continue;
      }

      if (ev.kind === "loop_stalled") {
        var stk = extra.stack || [];
        var sb2 = branches.get(traceId);
        // A stall reported against an already-finished request is not this
        // request's stall: the backend can only attribute to whatever frame
        // last ran, and a freeze in untraced code carries no live owner. Brand
        // nothing rather than brand the wrong row.
        if (sb2 && sb2.done) sb2 = null;
        if (sb2) {
          // A stall is a hold in progress; record it as a span too, so the
          // card lists it even if loop_blocked never lands (a hang has no end).
          if (extra.qualname && !sb2.blockSpans.some(function (sp) {
                return sp.nodeId === extra.node_id;
              })) {
            sb2.blockSpans.push({
              qualname: extra.qualname,
              ms: null, // still running; duration unknown
              nodeId: extra.node_id,
            });
            sb2.blockCount++;
            sb2.blocked = true;
          }
          if (extra.node_id != null) {
            var sn = sb2.nodesById.get(extra.node_id);
            if (sn) sn.wasBlocking = true;
          }
          // Mark the ROW, so the stall is visible on the request it belongs
          // to. A banner at the top of the zone is detached from its row —
          // and that row may be scrolled out of sight entirely.
          sb2.stalled = true;
        }
        loopStalled = {
          qualname: extra.qualname || "?",
          // Carried so drawNode can put the hot ring on the frame that is
          // frozen RIGHT NOW. Omitting it made that comparison test against
          // `undefined` on every frame, so the live indicator this event
          // exists to drive never once fired.
          node_id: extra.node_id != null ? extra.node_id : null,
          deepest: stk.length ? stk[stk.length - 1].qualname : null,
          stack: stk,
          sinceT: ev.t,
          traceId: traceId,
        };
        continue;
      }

      if (ev.kind === "loop_unstalled") {
        if (loopStalled) {
          var ub = branches.get(loopStalled.traceId);
          if (ub) ub.stalled = false;
        }
        loopStalled = null;
        continue;
      }

      if (ev.kind === "loop_blocked") {
        var bb = branches.get(traceId);
        var nb = bb && bb.nodesById.get(extra.node_id);
        var dur = extra.duration_ms || 0;
        // How long the node keeps its hot ring, in REAL time — a long block
        // would otherwise flash past unseen at slow playback speeds.
        var until =
          performance.now() +
          Math.max(BLOCK_FLASH_MIN_MS, Math.min(BLOCK_FLASH_MAX_MS, dur));
        if (bb) {
          bb.blocked = true; // persistent row tag (survives to DONE)
          bb.blockedMs += dur; // TOTAL time the loop was held by this request
          // The watchdog may already have opened a span for this same frame
          // while it was still stuck. Close that one out rather than adding a
          // second — otherwise one blocking call is listed twice, once as
          // "still running" and once with its duration.
          var open = null;
          for (var oi = 0; oi < bb.blockSpans.length; oi++) {
            if (bb.blockSpans[oi].ms == null && bb.blockSpans[oi].nodeId === extra.node_id) {
              open = bb.blockSpans[oi];
              break;
            }
          }
          if (open) {
            open.ms = dur;
            open.qualname = extra.qualname || open.qualname;
          } else {
            bb.blockCount++;
            bb.blockSpans.push({
              qualname: extra.qualname || "?",
              ms: dur,
              nodeId: extra.node_id,
            });
          }
        } else {
          // Trace blocked while still over the row cap (not admitted yet).
          // Stash it so the tag survives to when it IS admitted — with the
          // same shape the admitted path uses. Keeping only a max here made a
          // late-admitted row report one span and its card report none, so the
          // row and the card disagreed about the same request.
          var pre = blockedBefore.get(traceId);
          if (!pre) {
            pre = { ms: 0, count: 0, spans: [] };
            blockedBefore.set(traceId, pre);
          }
          pre.ms += dur;
          pre.count++;
          if (pre.spans.length < 32) {
            pre.spans.push({
              qualname: extra.qualname || "?",
              ms: dur,
              nodeId: extra.node_id,
            });
          }
        }
        if (nb) {
          nb.blocking = true;      // hot ring, expires on a real-time timer
          nb.wasBlocking = true;   // permanent: this is the frame that did it
          nb.blockUntil = until;
        }

        continue;
      }

      if (ev.kind === "loop_unblocked") {
        // Deliberately does nothing. The node's hot ring is time-driven
        // (BLOCK_FLASH_*, expired in drawNode): loop_unblocked arrives in the
        // same drain as loop_blocked, so clearing the ring here would make it
        // invisible. The span itself was already closed out on loop_blocked.
        continue;
      }

      if (ev.kind === "offload_start") {
        var bo = branches.get(traceId);
        if (bo) {
          bo.liveOffloads++;
          bo.offloadCount++;
          bo._offloadStartT.set(extra.node_id, ev.t);
          var no = bo.nodesById.get(extra.node_id);
          if (no) no.offloaded = true;
          // Only surface work belonging to a LOOP-zone request. For a sync
          // handler the offloaded frame IS the request, already shown as its
          // own row in the pool zone — a second entry would just duplicate it.
          if (bo.zone === "loop") {
            activeOffloads.set(traceId + ":" + extra.node_id, {
              traceId: traceId,
              nodeId: extra.node_id,
              qualname: (no && no.qualname) || ev.name || "?",
              hue: bo.hue,
              shortId: bo.shortId,
              startT: ev.t,
            });
          }
        }
        continue;
      }

      if (ev.kind === "offload_end") {
        var be = branches.get(traceId);
        if (be) {
          be.liveOffloads = Math.max(0, be.liveOffloads - 1);
          var ne = be.nodesById.get(extra.node_id);
          if (ne) ne.offloaded = false;
          var st = be._offloadStartT.get(extra.node_id);
          if (st != null) {
            be.offloadMs += Math.max(0, Math.round((ev.t - st) * 1000));
            be._offloadStartT.delete(extra.node_id);
          }
        }
        activeOffloads.delete(traceId + ":" + extra.node_id);
        continue;
      }
    }
    eventCount += events.length;
    eventCountEl.textContent = String(eventCount);
  }

  // --- Layout --------------------------------------------------------
  //
  // Simple layered tree layout (no force-directed simulation needed): each
  // node is assigned an integer "unit" slot by a post-order leaf-counting
  // pass — leaves get the next free slot, an internal node centers over its
  // children's slots — plus its tree depth. This is deterministic and cheap
  // to recompute every frame straight from the live node set.
  //
  // How this maps to the screen (see drawBranch): depth becomes X (deeper
  // calls sit further right, starting at the row's request-root node), and
  // the leaf-counting unit slot becomes a small Y offset from the row's
  // center line (siblings fan out vertically within their row's band,
  // instead of horizontally across the whole canvas as in a top-down tree).
  function assignPositions(node, depth, cursor) {
    node._depth = depth;
    if (depth > cursor.maxDepth) cursor.maxDepth = depth;
    if (node.children.length === 0) {
      node._x = cursor.next++;
    } else {
      var lo = Infinity;
      var hi = -Infinity;
      for (var i = 0; i < node.children.length; i++) {
        assignPositions(node.children[i], depth + 1, cursor);
        if (node.children[i]._x < lo) lo = node.children[i]._x;
        if (node.children[i]._x > hi) hi = node.children[i]._x;
      }
      node._x = (lo + hi) / 2;
    }
  }

  // --- Rendering ---------------------------------------------------------

  // Size the drawing buffer from the canvas's ACTUAL laid-out box. The old
  // version subtracted the header's height from the viewport, which disagreed
  // with the CSS (a hardcoded one-row header) as soon as the header wrapped —
  // the bitmap and the displayed box drifted apart and everything stretched.
  // Backing store scaled by devicePixelRatio, drawing surface kept in CSS px.
  //
  // The canvas used to be sized 1:1 with its CSS box, so on any retina display
  // the browser upscaled the whole bitmap — every glyph arrived soft, which is
  // a good part of why the text read as washed out however light or dark the
  // colour was. Scaling the backing store and pre-multiplying the context
  // means all the layout maths below keeps working in CSS pixels unchanged.
  // Capped at 2: beyond that the memory cost buys nothing visible.
  function resize() {
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    VW = w;
    VH = h;
  }
  window.addEventListener("resize", resize);
  resize();

  // Node screen rects from the last frame, used for hover tooltips. Positions
  // stored here are already in SCREEN space (scroll subtracted — see
  // layoutRows()), so hit-testing against raw mouseX/mouseY just works.
  var hoverRects = [];
  var mouseX = -1;
  var mouseY = -1;
  canvas.addEventListener("mousemove", function (e) {
    var r = canvas.getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
  });
  canvas.addEventListener("mouseleave", function () {
    mouseX = -1;
    mouseY = -1;
  });

  // --- Vertical scroll (per zone) -----------------------------------------
  // Each zone (loop / pool) has its own scroll offset in CONTENT space (0 =
  // its first row flush under its spine top). drawZone() clamps it every frame
  // to [0, contentHeight - bandRowsH] (content can shrink as branches finish)
  // and converts content positions to screen ones. The wheel scrolls whichever
  // zone the cursor is over (dividerY is recomputed every frame in render()).
  var scrollLoop = 0;
  var scrollPool = 0;
  var dividerY = 0;

  // Divider drag. `splitFrac` null = automatic (proportional to row counts,
  // the old behaviour); a number = the user pinned it there.
  var splitFrac = null;
  var dividerDrag = false;
  var dividerHover = false;
  var DIVIDER_GRAB = 7; // px either side of the line that counts as a grab

  function overDivider(y) {
    return Math.abs(y - dividerY) <= DIVIDER_GRAB;
  }

  // Where the divider may sit, in canvas px. Both zones keep at least
  // ZONE_MIN_PX unless the window is too short to give it to them, in which
  // case they split what there is evenly rather than starving one.
  function clampDividerY(y) {
    var top = ZONE_TOP;
    var bottom = VH - ZONE_BOTTOM_MARGIN;
    var avail = Math.max(40, bottom - top);
    if (avail < ZONE_MIN_PX * 2) return top + avail / 2;
    return Math.max(top + ZONE_MIN_PX, Math.min(bottom - ZONE_MIN_PX, y));
  }

  // Stored as a fraction so a pinned divider keeps its relative position when
  // the window is resized.
  function fracFromY(y) {
    var top = ZONE_TOP;
    var bottom = VH - ZONE_BOTTOM_MARGIN;
    var avail = Math.max(40, bottom - top);
    return (clampDividerY(y) - top) / avail;
  }

  canvas.addEventListener("pointerdown", function (e) {
    if (!overDivider(e.offsetY)) return;
    dividerDrag = true;
    splitFrac = fracFromY(e.offsetY);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", function (e) {
    if (dividerDrag) {
      splitFrac = fracFromY(e.offsetY);
      e.preventDefault();
      return;
    }
    dividerHover = overDivider(e.offsetY);
    canvas.style.cursor = dividerHover ? "ns-resize" : "default";
  });
  function endDividerDrag() {
    dividerDrag = false;
  }
  canvas.addEventListener("pointerup", endDividerDrag);
  canvas.addEventListener("pointercancel", endDividerDrag);
  // Back to automatic. Discoverable because the divider says so while pinned.
  canvas.addEventListener("dblclick", function (e) {
    if (!overDivider(e.offsetY)) return;
    splitFrac = null;
    e.preventDefault();
  });
  canvas.addEventListener(
    "wheel",
    function (e) {
      if (mouseY >= 0 && mouseY > dividerY) scrollPool += e.deltaY;
      else scrollLoop += e.deltaY;
      e.preventDefault();
    },
    { passive: false }
  );

  // Row layout from the last frame (screen-space top/height per branch),
  // used by both the scrollbar and the click-to-toggle handler below.
  var currentRows = [];

  // --- Click: select for the inspector + expand/collapse -------------------
  // (A click that landed on the divider is a drag, not a selection — see the
  // dividerHover guard inside the handler.)
  // Hit-test: map the click's Y (already screen-space, matching
  // currentRows[i].screenTop/height which had scrollY subtracted in
  // layoutRows) to the row it falls inside. ONE gesture does both: that row
  // becomes the inspector's subject and its call tree toggles open/closed.
  // X doesn't matter, only Y. A click that misses every row clears the
  // selection and closes the inspector.
  canvas.addEventListener("click", function (e) {
    var r = canvas.getBoundingClientRect();
    var clickY = e.clientY - r.top;
    // Releasing a divider drag fires a click too; that gesture was a resize,
    // not a row selection.
    if (overDivider(clickY)) return;
    for (var i = 0; i < currentRows.length; i++) {
      var row = currentRows[i];
      if (clickY >= row.screenTop && clickY <= row.screenTop + row.height) {
        row.branch.expanded = !row.branch.expanded;
        selectedTrace = row.branch.traceId;
        renderInspector();
        // Clicking a row is a direct request to see that row, so it always
        // brings the Request tab forward — even if you had gone back to the
        // guide. A rule that switches only sometimes is harder to predict
        // than one that always does.
        selectTab("request");
        return;
      }
    }
    selectedTrace = null;
    renderInspector();
    // Nothing selected any more: the request pane would just say "no request",
    // so hand the panel back to the guide.
    selectTab("guide");
  });

  // --- Request outcome helpers (task 14) ----------------------------------
  function isSlow(b) {
    return b.durationMs != null && b.durationMs > SLOW_REQ_MS;
  }

  // "200 · 42ms" / "!ValueError · 12ms" / "" while still in flight.
  function outcomeText(b) {
    var parts = [];
    if (b.error) parts.push("!" + b.error);
    else if (b.status != null) parts.push(String(b.status));
    if (b.durationMs != null) parts.push(b.durationMs + "ms");
    return parts.join(" · ");
  }

  function outcomeColor(b) {
    if (b.error) return T.bad;
    if (b.status != null && b.status >= 500) return T.bad;
    if (b.status != null && b.status >= 400) return T.warn;
    if (isSlow(b)) return T.warn;
    return T.dim;
  }

  // --- Row filter (task 14) -----------------------------------------------
  // Space-separated terms, ANDed: `path:/checkout`, `status:500`, `slow:true`,
  // `zone:threadpool|pool|loop`. Anything without a `key:` is a plain
  // substring matched against the path and the trace id. Deliberately NOT a
  // query language — keyword/substring only.
  // Filter parsing and matching live in viz/filter.js — pure functions of
  // (text) and (branch, terms), with no canvas and no shared state.
  var parseFilter = VIZ.filter.parse;
  function matchesFilter(b) {
    return VIZ.filter.matches(b, filterTerms, isSlow);
  }

  // Qualname under the cursor, read from the PREVIOUS frame's hoverRects (see
  // the hoverQual declaration) to drive cross-request highlighting.
  function qualnameAt(mx, my) {
    if (mx < 0) return null;
    for (var i = hoverRects.length - 1; i >= 0; i--) {
      var r = hoverRects[i];
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
        return r.qualname || null;
      }
    }
    return null;
  }

  // Full-tree metrics (leaf count, max depth) for an EXPANDED branch. Reuses
  // assignPositions, which also stamps node._depth/_x used later by the
  // actual draw walk — safe to compute once per frame and hand the numbers
  // to both the row-height pass and the draw pass, since nothing mutates the
  // tree in between (ingest() only runs between frames, not during one).
  function expandedMetrics(b) {
    var cursor = { next: 0, maxDepth: 0 };
    assignPositions(b.rootNode, 0, cursor);
    return { leafCount: Math.max(1, cursor.next), maxDepth: cursor.maxDepth };
  }

  // --- Variable-height row stacking + scroll math -------------------------
  // Each branch gets its own row height (fixed ~64px collapsed; sized to its
  // tree, clamped to [ROW_EXPANDED_MIN, 60% of viewport], when expanded).
  // Rows stack top-to-bottom in stable CREATION ORDER (by `seq`, ascending)
  // with cumulative offsets, so an expanded row pushes every row below it
  // further down. Ordering by seq (rather than a reusable row slot) is what
  // lets finished branches stay put — they never free up a slot for reuse,
  // so a fixed arrival-order key is what keeps row order stable frame to
  // frame. scrollY (content px, clamped here to what's actually scrollable)
  // then converts each row's content-space top/center into the screen-space
  // numbers everything else (drawing, hit-testing, the marker on the spine)
  // uses.
  // Lay out ONE zone's branch list in content space (top = 0). The caller
  // (drawZone) offsets by the zone's spine-top and scroll to get screen space.
  function layoutRowList(list) {
    var order = list.slice();
    order.sort(function (a, b) {
      return a.seq - b.seq;
    });

    var metrics = new Map(); // traceId -> {leafCount, maxDepth}, expanded rows only
    var rows = [];
    var y = 0;
    for (var i = 0; i < order.length; i++) {
      var b = order[i];
      var h;
      if (b.expanded) {
        var m = expandedMetrics(b);
        metrics.set(b.traceId, m);
        var raw = m.leafCount * SIBLING_GAP + 40; // + padding for labels/margins
        var maxH = ROW_EXPANDED_MAX_FRAC * VH;
        h = Math.max(ROW_EXPANDED_MIN, Math.min(maxH, raw));
      } else {
        h = ROW_COLLAPSED_H;
      }
      rows.push({ branch: b, contentTop: y, height: h, contentCenter: y + h / 2 });
      y += h + ROW_GAP;
    }
    return { rows: rows, metrics: metrics, contentHeight: y };
  }

  // --- Runtime state (task 4) --------------------------------------------
  // Measured state per request, distinguishing what the instrumentation can
  // actually see from what it's merely inferring:
  //   RUNNING  - loop zone: currently holds the loop and produced an in-root
  //              event recently; pool zone: a worker frame is executing.
  //   WAITING  - parked at an await (loop) / not yet on a worker (pool).
  //   UNTRACED - held the loop but has produced no in-root event for
  //              UNTRACED_AFTER seconds: the loop is running code outside the
  //              configured roots (stdlib / DB driver / HTTP client), so we
  //              can't claim this frame is the one running.
  //   DONE     - request_end seen.
  function activeNodeId(b) {
    return b.stack.length ? b.stack[b.stack.length - 1] : null;
  }
  function branchState(b) {
    if (b.done) return "DONE";
    // The loop is frozen inside this request right now. Outranks everything —
    // it is the single most important thing on the screen.
    if (b.stalled) return "STALLED";
    if (b.zone === "pool") return b.stack.length ? "RUNNING" : "WAITING";

    // Order matters, and it is not obvious. One trace can be BOTH offloading
    // and running on the loop at the same time: the task factory copies a
    // parent's trace id onto its child tasks, so `gather(run_in_threadpool(a),
    // b())` gives one trace a worker-bound child and a loop-bound sibling.
    // Checking liveOffloads first reported "WAITING · worker" while the loop
    // was demonstrably busy with this very request — the exact untruth this
    // zone work set out to remove.
    //
    // So a FRESH loop-holder claim wins: if the loop produced an in-root event
    // for this trace within UNTRACED_AFTER, the loop is running it, full stop.
    var holding = loopHolder === b.traceId;
    var stale =
      virtualT !== null && b.lastEventT && virtualT - b.lastEventT > UNTRACED_AFTER;
    if (holding && !stale) return "RUNNING";

    // Parked at an await whose work is on a worker thread. Still WAITING as
    // far as the loop is concerned (the loop is free either way) — but worth
    // distinguishing from waiting on i/o, because a worker is busy for it.
    // This also outranks a STALE holder claim: "a worker is definitely busy"
    // beats "the loop last touched this trace a while ago".
    if (b.liveOffloads > 0) return "WORKER";

    // Held the loop, but has gone quiet — the loop is off in code outside the
    // configured roots, so we cannot claim this frame is the one running.
    if (holding) return "UNTRACED";
    return "WAITING";
  }

  // Thin scrollbar on the right edge, only drawn when the row stack overflows
  // the viewport. Track spans the spine's visible extent; thumb size/position
  // mirror scrollY/maxScroll the same way a native scrollbar would.
  function drawScrollbar(spine, maxScroll, contentHeight, scrollVal) {
    if (maxScroll <= 0) return;
    var trackTop = spine.top;
    var trackH = spine.bottom - spine.top;
    var thumbH = Math.max(24, trackH * (trackH / contentHeight));
    var thumbY = trackTop + (scrollVal / maxScroll) * (trackH - thumbH);
    var x = VW - 6;
    ctx.fillStyle = T.track;
    ctx.fillRect(x, trackTop, 4, trackH);
    ctx.fillStyle = T.spine;
    ctx.fillRect(x, thumbY, 4, thumbH);
  }

  // The worker-token grid (borrowed/total). Drawn as a compact single-row
  // strip inside the THREADPOOL zone header (see drawZoneHeader), so the pool
  // saturation reads right beside the sync rows it explains.
  function drawPoolGrid(rect) {
    var total = pool.total || POOL_DEFAULT_TOTAL;
    var borrowed = pool.borrowed || 0;
    var saturated = borrowed >= total && total > 0;
    var gap = 2;
    var n = Math.max(1, total);
    var cellSize = Math.max(3, Math.min(10, (rect.w - gap * (n - 1)) / n));
    var y = rect.y + (rect.h - cellSize) / 2;
    for (var i = 0; i < total; i++) {
      var x = rect.x + i * (cellSize + gap);
      if (x + cellSize > rect.x + rect.w) break; // don't overflow the strip
      ctx.fillStyle = i < borrowed ? (saturated ? T.bad : T.ok) : T.track;
      ctx.fillRect(x, y, cellSize, cellSize);
    }
  }

  // Draw the event-loop spine: the vertical bar itself, its label block, and
  // a glowing marker next to the row of whichever request currently holds
  // the loop (so "who's running right now" reads at a glance). The spine
  // always spans the visible viewport (it doesn't scroll); the marker's Y
  // comes from the holder's already-scrolled row position, so it stays next
  // to the right row even when that row has scrolled — and is skipped
  // entirely if the row has scrolled out of view.
  // Header strip at the top of a zone: title + counts (loop) or title + the
  // worker-token grid (pool). Drawn in plain screen space, above the spine.
  // Offloaded calls we can SEE running, counted from offload_start/offload_end.
  //
  // The limiter's own figure is exact when it is taken, but `threadpool.py`
  // polls it from a task ON THE EVENT LOOP and only pushes a sample when the
  // numbers change — so while the loop is blocked it cannot sample at all, and
  // between two samples the header can still be showing the previous value
  // while rows are visibly running. Step mode freezes that window on screen.
  //
  // These events are per-request and cannot be sampled away, so they close the
  // gap. They are only a LOWER bound though: a request evicted by the row cap
  // is no longer counted here. Hence max() of the two below — each source can
  // only ever under-report, so neither can invent a busy worker.
  function observedLiveWorkers() {
    var live = 0;
    branches.forEach(function (b) {
      if (!b.done && b.liveOffloads > 0) live += b.liveOffloads;
    });
    return live;
  }

  function drawZoneHeader(zone, band, list) {
    var liveCount = 0;
    for (var i = 0; i < list.length; i++) if (!list[i].done) liveCount++;

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    var ty = band.top + ZONE_HEADER_H / 2 - 6;
    ctx.fillStyle = T.ink;
    ctx.font = "600 " + T.fs.zone + "px " + MONO;
    if (zone === "loop") {
      ctx.fillText("EVENT LOOP", 12, ty);
      ctx.font = T.fs.meta + "px " + MONO;
      if (loopStalled) {
        // Summary lives in the header, which is a dedicated strip. Drawing it
        // over the spine put it on top of the first row's own header.
        ctx.fillStyle = T.bad;
        var heldS =
          virtualT !== null ? Math.max(0, virtualT - loopStalled.sinceT) : 0;
        // Name both ends: the app frame you can change, and the deepest frame,
        // which says WHAT it is stuck in (socket.recv, a driver call) and is
        // usually library code the monitor never traces.
        var stallLabel =
          "⏱ LOOP STALLED " + heldS.toFixed(1) + "s in " + loopStalled.qualname;
        if (loopStalled.deepest && loopStalled.deepest !== loopStalled.qualname) {
          stallLabel += " → " + loopStalled.deepest;
        }
        ctx.fillText(stallLabel, 12, ty + 14);
      } else {
        ctx.fillStyle = T.dim;
        ctx.fillText(
          "1 thread · one runs at a time · " + liveCount + " live · " + list.length + " shown",
          12,
          ty + 14
        );
      }
    } else {
      var total = pool.total || POOL_DEFAULT_TOTAL;
      var borrowed = Math.max(pool.borrowed || 0, observedLiveWorkers());
      var queued = pool.queued || 0;
      var saturated = borrowed >= total && total > 0;
      ctx.fillText("THREADPOOL", 12, ty);
      ctx.font = T.fs.meta + "px " + MONO;
      ctx.fillStyle = queued > 0 ? T.warn : saturated ? T.bad : T.dim;
      // The queue depth is the ONE place the tool can say "waiting FOR a
      // worker". A row can only ever say "a worker is running my call": the
      // limiter knows how many calls are waiting for a free thread, but not
      // which request each belongs to. It comes from the backend on every
      // pool_sample and had never been displayed.
      // Same shape as the loop zone's "0 live · 8 shown". Without it, rows on
      // screen and a busy count of 0 look like a contradiction when in fact
      // every row is simply finished.
      var line =
        "worker threads · run in parallel · " +
        borrowed + "/" + total + " busy · " +
        liveCount + " live · " + list.length + " shown";
      if (queued > 0) line += " · " + queued + " waiting for a free thread";
      ctx.fillText(line, 12, ty + 14);
      // token grid, right-aligned in the header
      var gw = Math.min(220, VW * 0.3);
      drawPoolGrid({ x: VW - gw - 16, y: band.top + 8, w: gw, h: ZONE_HEADER_H - 16 });
    }
    ctx.textBaseline = "alphabetic";
  }

  // The zone's vertical spine + (loop zone only) the holder marker next to the
  // running row. A holder that has gone UNTRACED shows a dim hollow marker
  // instead of the bright glow — the loop is off in library code, and we say
  // so rather than implying this frame is still executing (task 4).
  function drawZoneSpine(zone, spine, rows) {
    ctx.save();
    ctx.strokeStyle = T.spine;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(spine.x, spine.top);
    ctx.lineTo(spine.x, spine.bottom);
    ctx.stroke();
    ctx.restore();

    // Live stall: the watchdog says the loop is not responding AT THIS MOMENT.
    // Takes precedence over the retrospective blocking flash below — if we know
    // it is stuck right now, say that rather than reporting a past span.
    if (zone === "loop" && loopStalled) {
      ctx.save();
      ctx.strokeStyle = T.bad;
      ctx.shadowColor = T.bad;
      ctx.shadowBlur = 14;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(spine.x, spine.top);
      ctx.lineTo(spine.x, spine.bottom);
      ctx.stroke();
      ctx.restore();

      // No text here: the spine's top is exactly where the first row draws its
      // own "#id  STATE" header, and the two overlapped into unreadable mush.
      // The wording lives in the zone header (drawZoneHeader) and on the
      // stalled row itself; the red spine is the at-a-glance signal.
      return;
    }

    // There is deliberately no separate "BLOCKED" banner here any more. It
    // reused 🔥, which now means "waited on the outside world", so one icon
    // carried two meanings; it appeared for about a second and then vanished;
    // and it said what the row's own durable tag already says. Three signals
    // now cover the ground without overlapping: ⏱ stalled (right now),
    // 🔥 blocking I/O (waited on something), ⚙ held the loop (long, cause
    // unknown). The hot ring lives on the NODE (node.blocking), set when
    // the event is ingested, so removing the banner cost nothing.

    if (zone !== "loop" || !loopHolder) return;
    var hb = branches.get(loopHolder);
    if (!hb || hb.zone !== "loop") return;
    var holderRow = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].branch.traceId === loopHolder) {
        holderRow = rows[i];
        break;
      }
    }
    if (!holderRow) return;
    var y = holderRow.screenCenter;
    if (y < spine.top - 10 || y > spine.bottom + 10) return;

    var state = branchState(hb);
    if (state === "UNTRACED") {
      ctx.save();
      ctx.strokeStyle = T.dim;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(spine.x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = T.dim;
      ctx.font = T.fs.meta + "px " + MONO;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("loop: untraced", spine.x + 12, y);
      ctx.restore();
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    } else {
      ctx.save();
      ctx.shadowColor = "hsl(" + hb.hue + ", 90%, 65%)";
      ctx.shadowBlur = 16;
      ctx.fillStyle = "hsl(" + hb.hue + ", 90%, 60%)";
      ctx.beginPath();
      ctx.arc(spine.x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // The divider, with a grip you can drag.
  //
  // It used to be recomputed from row counts every frame and clamped, so there
  // was no way to give the loop more room when that was the interesting half.
  // Dragging pins it (`splitFrac`); double-clicking un-pins it and hands it
  // back to the automatic proportion.
  function drawDivider(y) {
    ctx.save();
    var live = dividerDrag || dividerHover;
    ctx.strokeStyle = live ? T.info : T.spine;
    ctx.lineWidth = live ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(VW, y);
    ctx.stroke();

    var gw = 44, gh = 12, gx = VW / 2 - gw / 2;
    ctx.beginPath();
    roundRectPath(gx, y - gh / 2, gw, gh, 6);
    ctx.fillStyle = live ? T.info : T.panel;
    ctx.fill();
    ctx.strokeStyle = live ? T.info : T.spine;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = live ? T.bg : T.dim;
    for (var i = -1; i <= 1; i++) ctx.fillRect(VW / 2 + i * 7 - 1, y - 3, 2, 6);

    // The hint sits ABOVE the line, and only while the divider is under the
    // cursor. On the line it was struck through by the line itself; shown
    // permanently it was a sentence lying across the middle of the graph.
    if (live && splitFrac !== null) {
      ctx.font = T.fs.meta + "px " + MONO;
      ctx.fillStyle = T.dim;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("pinned · double-click for automatic", gx + gw + 12, y - 5);
      ctx.textBaseline = "alphabetic";
    }
    ctx.restore();
  }

  // The empty state.
  //
  // Centred on the whole CANVAS it landed exactly on the divider, which struck
  // a line through the sentence and dropped the drag grip on top of one of its
  // words. It belongs inside the EVENT LOOP band — that is where rows would
  // appear — and as a card rather than loose text, so it reads as a deliberate
  // empty state and stays legible whatever it overlaps.
  function drawIdleHint(band, filteredOut) {
    var title = filteredOut ? "No rows match the filter" : "No requests in flight";
    var hint = filteredOut
      ? "clear the filter box to see them again"
      : "send traffic to your app and they appear here";

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font = "600 " + (T.fs.zone + 1) + "px " + MONO;
    var w1 = ctx.measureText(title).width;
    ctx.font = T.fs.tag + "px " + MONO;
    var w2 = ctx.measureText(hint).width;

    var padX = 22, padY = 16;
    var boxW = Math.min(VW - 40, Math.max(w1, w2) + padX * 2);
    var boxH = 58;
    // Centred in the GRAPH area — the side panel is an overlay sitting on top
    // of the canvas, so centring on VW alone would tuck this under it. Its
    // width is read from the element rather than duplicated as a constant.
    var reserve = 0;
    try {
      var ov = document.getElementById("overlays");
      if (ov && ov.clientWidth) reserve = ov.clientWidth + 24;
    } catch (err) {
      reserve = 0;
    }
    var usable = Math.max(boxW + 40, VW - reserve);
    var cx = usable / 2;
    // Centre of the BAND, never of the canvas: on the canvas it landed on the
    // divider and was struck through by it.
    var cy = (band.top + ZONE_HEADER_H + band.bottom) / 2;

    ctx.beginPath();
    roundRectPath(cx - boxW / 2, cy - boxH / 2, boxW, boxH, 7);
    ctx.fillStyle = T.zoneBg;
    ctx.fill();
    ctx.strokeStyle = T.line;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = "600 " + (T.fs.zone + 1) + "px " + MONO;
    ctx.fillStyle = T.dim;
    ctx.fillText(title, cx, cy - 10);
    ctx.font = T.fs.tag + "px " + MONO;
    ctx.fillStyle = T.faint;
    ctx.fillText(hint, cx, cy + 11);

    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  // How long one call took, and — where it can be proved — how much of that
  // it actually occupied a thread for.
  //
  // The proof matters. `sys.monitoring` emits suspend/resume for the frame
  // that ACTUALLY yields, never for its callers: when `db_fetch` parks at an
  // await for 200ms, its parents `get_user` and the endpoint record no park at
  // all. So `elapsed - awaitMs` is only the truth for a LEAF frame. Applied to
  // a parent it counts every millisecond its children spent parked as loop
  // occupancy — measured on a real capture, an endpoint that held the loop for
  // 80ms was reported as holding it for 282.
  //
  // Which is the exact error this tool exists to correct, so a frame with
  // children gets no such claim: plain elapsed, and the children below it say
  // where the time actually went.
  function nodeTiming(node) {
    if (node.startT == null) return null;
    var end = node.endT != null ? node.endT : virtualT;
    if (end == null) return null;
    var ms = Math.max(0, (end - node.startT) * 1000);
    // Still running: a number that keeps climbing beats nothing, but say so.
    var suffix = node.endT == null ? "…" : "";

    if (node.children && node.children.length) return fmtMs(ms) + suffix;

    if (node.execution === "threadpool") return fmtMs(ms) + suffix + " on worker";
    if (node.awaitMs >= 5) {
      return fmtMs(ms) + suffix + " · " + fmtMs(Math.max(0, ms - node.awaitMs)) + " on loop";
    }
    return fmtMs(ms) + suffix + " on loop";
  }

  function fmtMs(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + "s";
    return Math.round(ms) + "ms";
  }

  function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // Drawing primitives, bound to this canvas once (see viz/primitives.js).
  // Bound rather than passed a ctx at every call, so the ~20 call sites below
  // read exactly as they did before the split.
  var P = VIZ.primitives(ctx, T, NODE_W, NODE_H);
  var roundRectPath = P.roundRectPath;
  var drawChip = P.drawChip;
  var drawEdge = P.drawEdge;
  var drawNodeEdge = P.drawNodeEdge;
  var clipToBox = VIZ.geometry.clipToBox;

  // Draw one node box plus edges to its children, recursively.
  function drawNode(node, x, y, w, h, scale, alpha, hue, activeId, pRect, detail) {
    var isActive = node.id === activeId;

    // Direction B: the body stays dark whatever the state, and the state is
    // carried by a 4px left stripe. The old palette flooded the box with a
    // saturated hue and put white text on top of it, which is where most of
    // the illegibility came from — the label's contrast changed with the hue
    // and the state, and at 11px there was nothing left to read.
    var fill = node.state === "done" ? T.nodeBodyDone : T.nodeBody;
    var borderColor = node.state === "done" ? T.nodeBorderDone : T.nodeBorder;
    var stripeColor = node.blocking || node.wasBlocking ? T.bad
                    : node.state === "done" ? T.nodeBorderDone
                    : node.offloaded ? T.worker
                    : node.state === "suspended" ? T.info
                    : "hsl(" + hue + ", 70%, 58%)";

    ctx.save();
    ctx.globalAlpha = alpha;

    // Glow ring on the frame currently holding the loop.
    if (isActive) {
      ctx.save();
      ctx.shadowColor = "hsl(" + hue + ", 90%, 65%)";
      ctx.shadowBlur = 14;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "hsl(" + hue + ", 90%, 70%)";
      ctx.beginPath();
      roundRectPath(x - w / 2 - 3, y - h / 2 - 3, w + 6, h + 6, T.radius + 2);
      ctx.stroke();
      ctx.restore();
    }

    // Blocking span (task 3): this frame is running sync/CPU work that is
    // freezing the loop. Hot red glow, drawn over the holder ring so it wins.
    // Expires on the same real-time window as the spine flash.
    if (node.blocking && node.blockUntil && performance.now() > node.blockUntil) {
      node.blocking = false;
    }
    if (loopStalled && loopStalled.node_id != null && node.id === loopStalled.node_id) {
      node.blocking = true; // frozen right now — same hot ring as a blocking span
    }
    if (node.wasBlocking && !node.blocking) {
      // The hot ring expires on a timer; this is the calm, permanent marker
      // so the culprit is still identifiable on a finished row.
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2;
      ctx.strokeStyle = T.bad;
      ctx.beginPath();
      roundRectPath(x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4, T.radius + 2);
      ctx.stroke();
      ctx.restore();
    }
    if (node.blocking) {
      ctx.save();
      ctx.shadowColor = T.bad;
      ctx.shadowBlur = 18;
      ctx.lineWidth = 3;
      ctx.strokeStyle = T.badHot;
      ctx.beginPath();
      roundRectPath(x - w / 2 - 3, y - h / 2 - 3, w + 6, h + 6, T.radius + 2);
      ctx.stroke();
      ctx.restore();
    }

    // Cross-request qualname highlight (task 14): hovering one node outlines
    // every frame of the SAME function in every other row, answering "where
    // else does this run" at a glance. Thin dashed blue — visually distinct
    // from the holder glow (solid, hue-coloured) and the blocking ring (thick
    // red). Skipped for request roots, whose qualname is "METHOD path".
    if (hoverQual && node.qualname === hoverQual && !node.isRoot) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = T.hover;
      ctx.beginPath();
      roundRectPath(x - w / 2 - 5, y - h / 2 - 5, w + 10, h + 10, T.radius + 3);
      ctx.stroke();
      ctx.restore();
    }

    var bx = x - w / 2, by = y - h / 2, r = T.radius;
    ctx.beginPath();
    roundRectPath(bx, by, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = node.isRoot ? 2 : 1;
    ctx.stroke();

    // The state stripe, clipped to the body so it keeps the rounded corner.
    var sw = Math.max(2, T.stripe * Math.min(1, scale + 0.35));
    ctx.save();
    ctx.beginPath();
    roundRectPath(bx, by, w, h, r);
    ctx.clip();
    ctx.fillStyle = stripeColor;
    ctx.fillRect(bx, by, sw, h);
    ctx.restore();

    ctx.fillStyle = node.state === "done" ? T.dim : T.ink;
    ctx.font = Math.max(10, Math.round(T.fs.node * scale)) + "px " + MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var label = truncate(node.qualname, Math.floor(17 / Math.max(scale, 0.5)));
    ctx.fillText(label, x + sw / 2, y);

    if (node.state === "suspended") {
      // Two bars rather than the ⏸ emoji: at this size the emoji rendered
      // differently on every OS and read as a smudge on a dark ground.
      ctx.fillStyle = T.info;
      var px = x + w / 2 - 11 * scale, py = y - h / 2 + 4 * scale;
      var bw = Math.max(1.5, 2.2 * scale), bh = Math.max(5, 8 * scale);
      ctx.fillRect(px, py, bw, bh);
      ctx.fillRect(px + bw + 2 * scale, py, bw, bh);
    }
    // Per-call timing, expanded rows only — it would not fit on a collapsed
    // one and the row header already gives the request total there.
    if (detail && scale > 0.5) {
      var timing = nodeTiming(node);
      if (timing) {
        ctx.font = Math.max(9, Math.round((T.fs.meta - 1) * scale)) + "px " + MONO;
        ctx.fillStyle = node.state === "done" ? T.faint : T.dim;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(timing, x + sw / 2, y + h / 2 + 4);
      }
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.restore();

    if (alpha > 0.05) {
      hoverRects.push({
        x: x - w / 2,
        y: y - h / 2,
        w: w,
        h: h,
        qualname: node.qualname,
        file: node.file,
        line: node.line,
        awaiting: node.awaiting,
        awaitDone: node.awaitDone,
      });
    }

    // Threadpool offload: this frame is sync work running on a threadpool
    // WORKER THREAD, not the event loop. Draw a SHORT dashed stub off the
    // node's right side with a "⇢ pool" tag (a full-canvas line to the fixed
    // corner box read as a glitch); the pinned THREADPOOL box shows the count.
    if (node.offloaded && !poolZoneDraw) {
      var sx = x + w / 2;
      var sy = y;
      var stub = 26 * scale;
      drawEdge(sx, sy, sx + stub, sy, T.worker, alpha * 0.9, true, 1.5, true);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "hsl(30, 90%, 62%)";
      ctx.font = Math.max(9, Math.round(T.fs.meta * scale)) + "px " + MONO;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("⇢ pool", sx + stub + 3, sy);
      ctx.restore();
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }

    // Children are positioned and recursed into by drawBranch's walk(), which
    // has the row/spine context needed to compute their screen coordinates.
  }

  // Tiny "▸"/"▾" affordance drawn just left of a row's request-root node, so
  // the fact that a row is click-to-expand/collapse is discoverable even
  // though the whole row is also a click target.
  function drawExpandArrow(rootX, rootY, scale, isExpanded) {
    ctx.save();
    ctx.fillStyle = T.dim;
    ctx.font = Math.max(10, Math.round(T.fs.node * scale)) + "px " + MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(isExpanded ? "▾" : "▸", rootX - (NODE_W * scale) / 2 - 10, rootY);
    ctx.restore();
  }

  // "[+N]" badge for the nodes hidden by the collapsed view.
  function drawBadge(x, y, n, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = T.fs.meta + "px " + MONO;
    ctx.fillStyle = T.dim;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("[+" + n + "]", x, y);
    ctx.restore();
  }

  // --- Collapsed active-path chain + [+N] logic ---------------------------
  // Default view for a row: instead of the full tree, draw just the ACTIVE
  // CALL PATH as a flat horizontal chain — the request root, then
  // branch.stack in order (root -> ... -> stack[top], the frame currently
  // executing/awaiting). This one formula also covers the "finished/idle"
  // case from the spec (stack empty -> chain is just the root) with no extra
  // branching. Anything not on that chain (finished sibling calls, whole
  // subtrees under still-open frames) is summarized as a single "[+N]" badge
  // where N = every node the branch has ever seen (nodesById.size) minus the
  // ones actually drawn from the chain (the stack-sourced ones; the root
  // itself isn't in nodesById so it doesn't count either way).

  // Small "#id" tag above a request's root node so each concurrent request is
  // identifiable by its short random id (from the backend trace_id).
  var STATE_STYLE = {
    RUNNING: { glyph: "●", color: T.ok, label: "RUNNING" },
    WAITING: { glyph: "○", color: T.dim, label: "WAITING" },
    UNTRACED: { glyph: "⋯", color: T.warn, label: "UNTRACED" },
    WORKER: { glyph: "⇢", color: T.worker, label: "WAITING · worker" },
    STALLED: { glyph: "⏱", color: T.bad, label: "STALLED" },
    DONE: { glyph: "✓", color: T.faint, label: "DONE" },
  };

  function drawRowHeader(b, state, rowY) {
    ctx.save();
    var y = rowY - NODE_H / 2 - 4;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    var x = ROOT_X - NODE_W / 2;

    // Gutter mark on the row the inspector is currently describing.
    if (selectedTrace === b.traceId) {
      ctx.font = "600 " + T.fs.tag + "px " + MONO;
      ctx.fillStyle = T.info;
      ctx.fillText("▍", x - 9, y);
    }

    // Short id only — trace ids are 16 hex chars now; the full one is in the
    // inspector.
    ctx.font = "600 " + T.fs.tag + "px " + MONO;
    ctx.fillStyle = "hsl(" + b.hue + ", 60%, 72%)";
    var idText = "#" + b.shortId;
    ctx.fillText(idText, x, y);
    x += ctx.measureText(idText).width + 10;

    // Chips from here on. A tinted ground is what makes a glyph findable at
    // this size on a near-black canvas, and it groups each tag's glyph with
    // its label instead of leaving them as loose text on the row.
    var st = STATE_STYLE[state] || STATE_STYLE.WAITING;
    x += drawChip(x, y - T.fs.tag / 2, st.glyph + " " + st.label, st.color) + 7;

    // Outcome tag (task 14): "200 · 42ms", amber past the slow threshold, red
    // for 5xx or a raised exception — so a bad or slow request reads without
    // opening the inspector.
    var outcome = outcomeText(b);
    if (outcome) {
      x += drawChip(x, y - T.fs.tag / 2, outcome, outcomeColor(b)) + 7;
    }

    // Durable "⇢ pool" tag: this request handed work to a worker thread at
    // some point. The row never moves zones, and the pool-zone entry only
    // exists while the call runs — so without this a finished request shows
    // no sign it used a worker at all.
    // Only in the LOOP zone. In the THREADPOOL zone the whole row already
    // means "this ran on a worker", so the chip restates the row's own zone —
    // and reads as a second, smaller number competing with the request total.
    // The per-node "⇢ pool" stub is suppressed there for the same reason
    // (see poolZoneDraw); this chip was the one marker that had been missed.
    if (b.offloadCount && b.zone !== "pool") {
      var ptag = "⇢ pool";
      if (b.offloadCount > 1) ptag += " ×" + b.offloadCount;
      if (b.offloadMs) ptag += " " + b.offloadMs + "ms";
      x += drawChip(x, y - T.fs.tag / 2, ptag, T.worker) + 7;
    }

    // The verdict, split into its two genuinely different kinds.
    //
    //   🔥 blocking I/O — the loop thread waited on the outside world. A bug at
    //      ANY speed, so this shows even when nothing tripped a threshold; it
    //      is the only signal that catches a 3ms database call.
    //   ⚙ held the loop — it ran too long, and we have NO evidence of what it
    //      was doing. Deliberately not called "CPU-bound": the absence of a
    //      detected wait is not proof of computation. `time.sleep` raises no
    //      audit event and leaves no Python frame (it is C), and neither does a
    //      read on an already-open socket — so the most iconic blocking call of
    //      all would have been mislabelled as computation. Same principle as
    //      the UNTRACED state: never look more certain than the instrumentation
    //      actually is.
    if (b.ioCalls.size) {
      ctx.fillStyle = T.bad;
      var kinds = [];
      b.ioCalls.forEach(function (c) {
        kinds.push(c);
      });
      // Terse: the CATEGORY stays (two words, and it is the kind of problem),
      // but function names moved to the inspector — fine for one blocking call
      // and unreadable for several.
      var iotag = "🔥 blocking I/O: " + kinds.sort().join(", ");
      if (b.blockedMs) iotag += " " + (b.blockedMs / 1000).toFixed(2) + "s";
      if (b.blockCount > 1) iotag += " ×" + b.blockCount;
      drawChip(x, y - T.fs.tag / 2, iotag, T.bad);
    } else if (b.blocked) {
      var cputag = "⚙ held the loop";
      if (b.blockedMs) cputag += " " + (b.blockedMs / 1000).toFixed(2) + "s";
      if (b.blockCount > 1) cputag += " ×" + b.blockCount;
      drawChip(x, y - T.fs.tag / 2, cputag, T.warn);
    }

    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  // Which nodes a COLLAPSED row shows, and where they sit.
  //
  // Shared by the layout pass (which needs the height) and the draw pass. The
  // shape is a small TREE, not a chain: positions come from real call depth,
  // and nodes at the same depth are siblings stacked vertically. Laying it out
  // by array order instead drew two siblings in a horizontal line, which reads
  // as "the left one called the right one" — flatly wrong for two blocking
  // calls made from the same handler.
  function collapsedShape(b) {
    var picked = [b.rootNode];
    var seen = {};
    seen[b.rootNode.id] = true;

    function add(n) {
      if (!n || seen[n.id]) return;
      picked.push(n);
      seen[n.id] = true;
    }

    // the active call path
    for (var i = 0; i < b.stack.length; i++) add(b.nodesById.get(b.stack[i]));

    // Only the active path. Pinning the frames that blocked was tried and
    // reverted: on a finished row it left several wide nodes hanging around,
    // colliding with the row's own tag, for information that belongs in the
    // inspector. Running rows show what is running; finished rows collapse
    // back to the request.

    function depthOf(n) {
      if (n.isRoot) return 0;
      var d = 1;
      var cur = n;
      var guard = 0;
      while (cur.parent_id != null && guard++ < 64) {
        var parent = b.nodesById.get(cur.parent_id);
        if (!parent) break;
        d++;
        cur = parent;
      }
      return d;
    }

    var byDepth = {};
    var maxDepth = 0;
    for (var j = 0; j < picked.length; j++) {
      var d = depthOf(picked[j]);
      if (d > maxDepth) maxDepth = d;
      (byDepth[d] = byDepth[d] || []).push(picked[j]);
    }

    var maxSiblings = 1;
    var placed = [];
    for (var dd in byDepth) {
      var row = byDepth[dd];
      if (row.length > maxSiblings) maxSiblings = row.length;
      for (var q = 0; q < row.length; q++) {
        placed.push({ node: row[q], depth: Number(dd), slot: q, of: row.length });
      }
    }
    return { placed: placed, maxDepth: maxDepth, maxSiblings: maxSiblings };
  }

  function drawBranchCollapsed(b, spine, rowY, alpha, activeId, holds) {
    var shape = collapsedShape(b);
    var availW = VW - ROOT_X - MARGIN;
    var scaleX =
      shape.maxDepth > 0 ? Math.min(1, availW / (shape.maxDepth * NODE_SPACING_X)) : 1;
    var scale = Math.max(MIN_SCALE, scaleX);

    // position everything first, so an edge can start at its real PARENT
    // rather than at whatever happened to be drawn before it
    var pos = {};
    for (var i = 0; i < shape.placed.length; i++) {
      var e = shape.placed[i];
      pos[e.node.id] = {
        x: ROOT_X + e.depth * NODE_SPACING_X * scale,
        y: rowY + (e.slot - (e.of - 1) / 2) * SIBLING_GAP * scale,
      };
    }

    var edgeColor = "hsl(" + b.hue + ", 60%, 50%)";
    var rightmost = ROOT_X;

    for (var m = 0; m < shape.placed.length; m++) {
      var node = shape.placed[m].node;
      var p = pos[node.id];
      if (p.x > rightmost) rightmost = p.x;

      if (node.isRoot) {
        var rootEnd = clipToBox(spine.x, rowY, p.x, p.y, p.x, p.y, NODE_W / 2, NODE_H / 2);
        drawEdge(
          spine.x,
          rowY,
          rootEnd.x,
          rootEnd.y,
          holds ? "hsl(" + b.hue + ", 90%, 65%)" : edgeColor,
          alpha * (holds ? 1 : 0.45),
          !holds,
          holds ? 2.5 : 1.5,
          true
        );
      } else {
        var parentPos =
          node.parent_id != null && pos[node.parent_id]
            ? pos[node.parent_id]
            : pos[b.rootNode.id];
        var edgeAlpha = alpha;
        var dashed = false;
        if (node.state === "suspended" && !node.offloaded) {
          edgeAlpha = alpha * 0.3;
          dashed = true;
        }
        drawNodeEdge(parentPos.x, parentPos.y, p.x, p.y, edgeColor, edgeAlpha, dashed);
      }

      drawNode(node, p.x, p.y, NODE_W * scale, NODE_H * scale, scale, alpha, b.hue, activeId, null);
    }

    drawExpandArrow(ROOT_X, rowY, scale, false);

    var shown = shape.placed.length - 1; // minus the synthetic request root
    var hidden = b.nodesById.size - shown;
    if (hidden > 0) {
      drawBadge(rightmost + (NODE_W * scale) / 2 + 10, rowY, hidden, alpha);
    }
  }

  // Full-tree view (the original rendering, unchanged): depth->x,
  // sibling-slot->y-within-row. `metrics` ({leafCount, maxDepth}) was already
  // computed this frame by layoutRows() (which also stamped node._depth/_x
  // via assignPositions), so this only has to figure out `scale` and walk.
  //
  // Row math: the row's vertical center line is fixed by its own height
  // (rowY/rowHeight, from layoutRows — no longer a fixed 1/MAX_REQ band).
  // Each node's screen position is:
  //   x = ROOT_X + depth * NODE_SPACING_X * scale   (depth 0 = request root,
  //                                                   right at the spine side)
  //   y = rowY + (unitSlot - (leafCount-1)/2) * SIBLING_GAP * scale
  // `scale` shrinks (down to MIN_SCALE) only as far as needed so the tree's
  // max depth fits the available width and its sibling spread fits the row's
  // OWN height; most rows still draw at scale 1 since row height is sized to
  // the tree in layoutRows().
  function drawBranchExpanded(b, spine, rowY, rowHeight, alpha, metrics, activeId, holds) {
    var leafCount = metrics.leafCount;
    var maxDepth = metrics.maxDepth;

    var availW = VW - ROOT_X - MARGIN;
    var scaleX = maxDepth > 0 ? Math.min(1, availW / (maxDepth * NODE_SPACING_X)) : 1;
    var neededH = leafCount * SIBLING_GAP;
    var scaleY = Math.min(1, (rowHeight * ROW_BAND_FILL) / Math.max(1, neededH));
    var scale = Math.max(MIN_SCALE, Math.min(1, scaleX, scaleY));

    var rootPos = null;

    function pos(node) {
      return {
        x: ROOT_X + node._depth * NODE_SPACING_X * scale,
        y: rowY + (node._x - (leafCount - 1) / 2) * SIBLING_GAP * scale,
      };
    }

    function walk(node, parentPos) {
      var p = pos(node);
      var edgeAlpha = alpha;
      var dashed = false;
      var edgeColor = "hsl(" + b.hue + ", 60%, 50%)";

      if (node.isRoot) {
        // Connector from the request root to the spine: bright + thick while
        // this row is running, faint + dashed while it's parked.
        var rootEnd = clipToBox(spine.x, rowY, p.x, p.y, p.x, p.y, NODE_W / 2, NODE_H / 2);
        drawEdge(
          spine.x,
          rowY,
          rootEnd.x,
          rootEnd.y,
          holds ? "hsl(" + b.hue + ", 90%, 65%)" : edgeColor,
          alpha * (holds ? 1 : 0.45),
          !holds,
          holds ? 2.5 : 1.5,
          true
        );
        rootPos = p;
      } else if (parentPos) {
        // A suspended node's edge up to its parent goes faint — "parked".
        if (node.state === "suspended" && !node.offloaded) {
          edgeAlpha = alpha * 0.3;
          dashed = true;
        }
        drawNodeEdge(parentPos.x, parentPos.y, p.x, p.y, edgeColor, edgeAlpha, dashed);
      }

      drawNode(
        node,
        p.x,
        p.y,
        NODE_W * scale,
        NODE_H * scale,
        scale,
        alpha,
        b.hue,
        activeId,
        null,
        true // expanded: per-call timing under each box
      );

      for (var i = 0; i < node.children.length; i++) {
        walk(node.children[i], p);
      }
    }

    walk(b.rootNode, null);
    if (rootPos) drawExpandArrow(rootPos.x, rootPos.y, scale, true);
  }

  // One offloaded call currently executing on a worker thread. This is NOT a
  // request — the owning request is parked on the event loop and keeps its row
  // there. This is the unit of work the worker runs on its behalf, so it is
  // labelled with the owner's #id and drawn in the owner's hue.
  function drawWorkRow(item, spine, rowY) {
    var w = NODE_W;
    var h = NODE_H;
    var x = ROOT_X;

    drawEdge(spine.x, rowY, x - w / 2, rowY, T.worker, 0.9, true, 1.5, true);

    ctx.save();
    ctx.fillStyle = "hsl(" + item.hue + ", 55%, 26%)";
    ctx.strokeStyle = "hsl(30, 90%, 55%)";
    ctx.lineWidth = 1.5;
    ctx.fillRect(x - w / 2, rowY - h / 2, w, h);
    ctx.strokeRect(x - w / 2, rowY - h / 2, w, h);
    ctx.fillStyle = T.ink;
    ctx.font = T.fs.tag + "px " + MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(truncate(item.qualname, 18), x, rowY);
    ctx.restore();

    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    var ty = rowY - h / 2 - 4;
    ctx.font = "600 " + T.fs.tag + "px " + MONO;
    ctx.fillStyle = "hsl(" + item.hue + ", 60%, 72%)";
    var idText = "#" + item.shortId;
    ctx.fillText(idText, x - w / 2, ty);
    ctx.font = T.fs.meta + "px " + MONO;
    ctx.fillStyle = T.worker;
    var elapsed =
      virtualT !== null ? Math.max(0, Math.round((virtualT - item.startT) * 1000)) : 0;
    ctx.fillText(
      "⇢ on worker " + elapsed + "ms",
      x - w / 2 + ctx.measureText(idText).width + 10,
      ty
    );
    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    hoverRects.push({
      x: x - w / 2,
      y: rowY - h / 2,
      w: w,
      h: h,
      qualname: item.qualname,
      awaiting: "running on a worker thread for #" + item.shortId,
      awaitDone: false,
    });
  }

  function drawTooltip() {
    if (mouseX < 0) return;
    for (var i = hoverRects.length - 1; i >= 0; i--) {
      var r = hoverRects[i];
      if (mouseX >= r.x && mouseX <= r.x + r.w && mouseY >= r.y && mouseY <= r.y + r.h) {
        var lines = [r.qualname];
        if (r.file) lines.push(r.file + ":" + (r.line || "?"));
        if (r.awaiting) lines.push((r.awaitDone ? "await complete: " : "awaiting ") + r.awaiting);
        ctx.font = T.fs.tag + "px " + MONO;
        var w = Math.max.apply(
          null,
          lines.map(function (l) {
            return ctx.measureText(l).width;
          })
        ) + 12;
        var h = lines.length * 14 + 8;
        var tx = Math.min(mouseX + 12, VW - w - 4);
        var ty = Math.min(mouseY + 12, VH - h - 4);
        ctx.fillStyle = T.panel;
        ctx.strokeStyle = T.line;
        ctx.fillRect(tx, ty, w, h);
        ctx.strokeRect(tx, ty, w, h);
        ctx.fillStyle = T.ink;
        ctx.textBaseline = "top";
        for (var l = 0; l < lines.length; l++) {
          ctx.fillText(lines[l], tx + 6, ty + 4 + l * 14);
        }
        ctx.textBaseline = "alphabetic";
        return;
      }
    }
  }

  // Draw one zone: its header, spine, and row stack (clipped to the zone's
  // band, scrolled by its own offset). Returns the laid-out rows (for the
  // shared click/hover hit-test) and the clamped scroll offset.
  function drawZone(zone, band, list, scrollVal, work) {
    var spineTop = band.top + ZONE_HEADER_H;
    // Never past the band. Forcing a minimum height here pushed the row area
    // beyond the zone it belongs to whenever the band was short, which is how
    // rows ended up drawn over the next zone's header.
    var spineBottom = Math.max(spineTop, band.bottom);
    var bandRowsH = spineBottom - spineTop;

    var layout = layoutRowList(list);
    // Live worker entries stack below the request rows in the same content
    // space, so they scroll together and count toward the scrollable height.
    var workRows = [];
    if (work && work.length) {
      var wy = layout.contentHeight;
      for (var w = 0; w < work.length; w++) {
        workRows.push({
          item: work[w],
          contentTop: wy,
          height: WORK_ROW_H,
          contentCenter: wy + WORK_ROW_H / 2,
        });
        wy += WORK_ROW_H + ROW_GAP;
      }
      layout.contentHeight = wy;
    }
    var maxScroll = Math.max(0, layout.contentHeight - bandRowsH);
    var s = Math.max(0, Math.min(scrollVal, maxScroll));

    for (var i = 0; i < layout.rows.length; i++) {
      layout.rows[i].screenTop = spineTop + layout.rows[i].contentTop - s;
      layout.rows[i].screenCenter = spineTop + layout.rows[i].contentCenter - s;
    }
    for (var k = 0; k < workRows.length; k++) {
      workRows[k].screenTop = spineTop + workRows[k].contentTop - s;
      workRows[k].screenCenter = spineTop + workRows[k].contentCenter - s;
    }

    drawZoneHeader(zone, band, list);
    var spine = { x: SPINE_X, top: spineTop, bottom: spineBottom };
    drawZoneSpine(zone, spine, layout.rows);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, spineTop - 2, VW, bandRowsH + 4);
    ctx.clip();
    poolZoneDraw = zone === "pool";
    for (var j = 0; j < layout.rows.length; j++) {
      var row = layout.rows[j];
      // cull rows scrolled out of the band
      if (
        row.screenCenter < spineTop - row.height ||
        row.screenCenter > spineBottom + row.height
      ) {
        continue;
      }
      var b = row.branch;
      var state = branchState(b);
      // Only a RUNNING row is drawn bright/holding; WAITING/UNTRACED/DONE draw
      // faint. In the pool zone several rows can run at once (real threads),
      // so more than one may be "holding" simultaneously.
      var holds = state === "RUNNING";
      var activeId =
        zone === "loop"
          ? holds
            ? activeNodeId(b)
            : null
          : !b.done && b.stack.length
          ? activeNodeId(b)
          : null;
      if (b.expanded) {
        drawBranchExpanded(
          b,
          spine,
          row.screenCenter,
          row.height,
          1,
          layout.metrics.get(b.traceId),
          activeId,
          holds
        );
      } else {
        drawBranchCollapsed(b, spine, row.screenCenter, 1, activeId, holds);
      }
      drawRowHeader(b, state, row.screenCenter);
    }
    for (var m = 0; m < workRows.length; m++) {
      var wr = workRows[m];
      if (wr.screenCenter < spineTop - wr.height || wr.screenCenter > spineBottom + wr.height) {
        continue;
      }
      drawWorkRow(wr.item, spine, wr.screenCenter);
    }

    poolZoneDraw = false;
    ctx.restore();

    drawScrollbar(spine, maxScroll, layout.contentHeight, s);
    return { rows: layout.rows, work: workRows, scroll: s };
  }

  function render() {
    advancePlayback();

    // Resolve the hovered qualname from LAST frame's rects, before they are
    // cleared below — drawNode needs it while drawing THIS frame.
    hoverQual = qualnameAt(mouseX, mouseY);

    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, VW, VH);
    hoverRects = [];

    // Split kept branches into the two zones (see b.zone, set in ingest()),
    // applying the header row filter. This is DISPLAY-only: admission to a row
    // slot happens in getOrCreateBranch and is unaffected by the filter.
    var loopList = [];
    var poolList = [];
    branches.forEach(function (b) {
      if (!matchesFilter(b)) return;
      (b.zone === "pool" ? poolList : loopList).push(b);
    });

    // Offloaded calls running RIGHT NOW belong in the threadpool zone as their
    // own entries — the worker is busy with them, while the request that asked
    // for them stays parked in the loop zone. Honour the row filter through
    // the owning request.
    var poolWork = [];
    activeOffloads.forEach(function (item) {
      var owner = branches.get(item.traceId);
      if (owner && matchesFilter(owner)) poolWork.push(item);
    });
    poolWork.sort(function (a, b) {
      return a.startT - b.startT;
    });

    // Divider sits proportionally to each zone's row count, clamped so both
    // headers always show.
    var top = ZONE_TOP;
    var bottom = VH - ZONE_BOTTOM_MARGIN;
    var avail = Math.max(40, bottom - top);
    var n = loopList.length + poolList.length + poolWork.length;
    var frac = n === 0 ? 0.5 : loopList.length / n;
    frac = Math.max(ZONE_MIN_FRAC, Math.min(ZONE_MAX_FRAC, frac));
    // A pinned divider wins over the automatic proportion — but neither may
    // squeeze a zone below its pixel floor.
    if (splitFrac !== null) frac = splitFrac;
    dividerY = clampDividerY(top + frac * avail);

    var loopBand = { top: top, bottom: dividerY - ZONE_DIV_GAP };
    var poolBand = { top: dividerY + ZONE_DIV_GAP, bottom: bottom };

    var lr = drawZone("loop", loopBand, loopList, scrollLoop);
    scrollLoop = lr.scroll;
    drawDivider(dividerY);
    var pr = drawZone("pool", poolBand, poolList, scrollPool, poolWork);
    scrollPool = pr.scroll;

    currentRows = lr.rows.concat(pr.rows); // shared click/scroll hit-test

    // Keep the inspector current as the selected request progresses — but not
    // at 60fps, since it rewrites innerHTML.
    if (selectedTrace && performance.now() - lastInspectorPaint > 200) {
      renderInspector();
    }

    if (loopList.length === 0 && poolList.length === 0 && poolWork.length === 0) {
      drawIdleHint(loopBand, branches.size > 0);
    }

    drawTooltip();
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // --- WebSocket -----------------------------------------------------

  // The dashboard mount path is configurable (`visualize(app, path=...)`), so
  // the socket URL is DERIVED from the page's own location rather than
  // hardcoding "/_viz". The page is served at the mount root and the socket is
  // its "ws" sibling, so whatever the app mounted us at, location.pathname
  // already reflects it — no server-side templating, no build step.
  function wsUrl() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var base = location.pathname.replace(/\/+$/, ""); // "/_viz/" -> "/_viz"
    return proto + "//" + location.host + base + "/ws";
  }

  function connect() {
    var ws = new WebSocket(wsUrl());

    ws.onopen = function () {
      statusEl.classList.add("connected");
      statusTextEl.textContent = "connected";
      // Re-arm backlog skipping for this (re)connection.
      sawFirstFrame = false;
      connectBaselineT = -Infinity;
      // Reconnecting restarts the seq baseline (the server may have restarted,
      // and we skip the backlog again), so don't count the gap across reconnect.
      lastSeq = null;
    };
    ws.onmessage = function (msg) {
      try {
        var frame = JSON.parse(msg.data);
        if (!frame.events) return;
        if (!sawFirstFrame) {
          // First frame IS the backlog snapshot. Set the live edge to its
          // newest timestamp and drop it; only newer events get animated.
          sawFirstFrame = true;
          try {
            var meta = frame.meta;
            if (meta && meta.multi_worker) {
              if (multiWorkerWarnEl) multiWorkerWarnEl.hidden = false;
              syncAlerts();
              if (workerPidEl) workerPidEl.textContent = String(meta.worker_pid || "?");
            }
          } catch (e) { /* ignore */ }
          for (var k = 0; k < frame.events.length; k++) {
            if (frame.events[k].t > connectBaselineT) connectBaselineT = frame.events[k].t;
          }
          return;
        }
        for (var s = 0; s < frame.events.length; s++) noteSeq(frame.events[s].seq);
        bufferEvents(frame.events);
      } catch (e) {
        /* ignore malformed frame */
      }
    };
    ws.onclose = function () {
      statusEl.classList.remove("connected");
      statusTextEl.textContent = "disconnected";
      setTimeout(connect, 1000);
    };
    ws.onerror = function () {
      ws.close();
    };
  }
  connect();

  // --- Controls ------------------------------------------------------
  // Speed slider: slider value 5..100 -> SPEED 0.05..1.0 (fraction of realtime).
  // Only relevant in continuous mode; step mode pauses the clock entirely.
  var speedInput = document.getElementById("ld-speed");
  var speedVal = document.getElementById("ld-speed-val");
  function applySpeed() {
    SPEED = Math.max(5, Math.min(100, parseInt(speedInput.value, 10) || 20)) / 100;
    if (speedVal) speedVal.textContent = SPEED.toFixed(2) + "×";
  }
  if (speedInput) {
    speedInput.addEventListener("input", applySpeed);
    applySpeed();
  }

  // "max req" control: how many rows may be KEPT on screen (done ones no
  // longer free themselves — see the eviction logic in getOrCreateBranch()).
  var maxReqInput = document.getElementById("ld-maxreq");
  function applyMaxReq() {
    MAX_REQ = Math.max(1, Math.min(50, parseInt(maxReqInput.value, 10) || 20));
  }
  if (maxReqInput) {
    maxReqInput.addEventListener("input", applyMaxReq);
    applyMaxReq();
  }

  // "clear" button: wipe every kept/hidden branch and reset the row-ordering
  // and scroll state so the view starts fresh. Deliberately left alone:
  // eventCount (global counter), the playback clock (virtualT/maxSeenT/
  // lastFrameMs), SPEED, stepMode, and the WebSocket connection — so events
  // already in flight from the server keep animating normally afterward.
  var clearBtn = document.getElementById("ld-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      branches.clear();
      nextSeq = 0;
      blockedBefore.clear();
      hiddenByCap = 0;
      syncAlerts();
      pending = [];
      loopHolder = null;
      loopStalled = null;
      selectedTrace = null;
      scrollLoop = 0;
      scrollPool = 0;
      droppedCount = 0;
      if (dropCountEl) dropCountEl.textContent = "0";
      if (dropWarnEl) dropWarnEl.hidden = true;
      syncAlerts();
      renderInspector();
    });
  }

  // Step mode toggle + button. Off = normal slow-motion playback (unchanged).
  // On = playback pauses; each "▶ step" click hands the loop to the next
  // request (see doStep() above).
  var stepToggle = document.getElementById("ld-step");
  var stepBtn = document.getElementById("ld-step-btn");
  function applyStepMode() {
    stepMode = !!(stepToggle && stepToggle.checked);
    if (stepBtn) stepBtn.disabled = !stepMode;
  }
  if (stepToggle) {
    stepToggle.addEventListener("change", applyStepMode);
    applyStepMode();
  }
  if (stepBtn) {
    stepBtn.addEventListener("click", function () {
      if (stepMode) doStep();
    });
  }

  // "slow req (ms)": duration threshold above which a request's outcome tag
  // goes amber and `slow:true` matches it. Frontend-only — duration arrives on
  // request_end, so retuning the threshold needs no server round trip.
  var slowInput = document.getElementById("ld-slow");
  function applySlow() {
    SLOW_REQ_MS = Math.max(1, Math.min(60000, parseInt(slowInput.value, 10) || 500));
    renderInspector();
  }
  if (slowInput) {
    slowInput.addEventListener("input", applySlow);
    applySlow();
  }

  // Row filter box (see parseFilter/matchesFilter).
  var filterInput = document.getElementById("ld-filter");
  function applyFilter() {
    filterTerms = parseFilter(filterInput.value);
  }
  if (filterInput) {
    filterInput.addEventListener("input", applyFilter);
    applyFilter();
  }

  // --- Request inspector (task 14) ----------------------------------------
  // A DOM overlay, not canvas drawing: the trace id has to be selectable text
  // (that's the whole point of showing it), and this keeps the canvas draw
  // path from growing another responsibility. Repainted on selection change
  // and at most every 200ms while the selected request is still running.
  var panelEl = document.getElementById("panel");
  var inspectorBody = document.getElementById("inspector-body");
  var requestEmpty = document.getElementById("request-empty");
  var tabGuide = document.getElementById("tab-guide");
  var tabRequest = document.getElementById("tab-request");
  var paneGuide = document.getElementById("pane-guide");
  var paneRequest = document.getElementById("pane-request");
  var panelCollapse = document.getElementById("panel-collapse");

  // The guide is the DEFAULT tab, not the request detail.
  //
  // Two stacked panels became one with two tabs, and the obvious default was
  // the request pane — except it is empty until you click something, so a
  // first run greeted you with nothing at all. Leading with the guide means
  // the panel always has something in it and teaches before it is asked.
  function selectTab(which) {
    var guide = which !== "request";
    if (tabGuide) tabGuide.setAttribute("aria-selected", String(guide));
    if (tabRequest) tabRequest.setAttribute("aria-selected", String(!guide));
    if (paneGuide) paneGuide.hidden = !guide;
    if (paneRequest) paneRequest.hidden = guide;
  }
  if (tabGuide) tabGuide.addEventListener("click", function () { selectTab("guide"); });
  if (tabRequest) tabRequest.addEventListener("click", function () { selectTab("request"); });

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }

  function irow(label, value) {
    return (
      '<div class="irow"><span class="ik">' +
      esc(label) +
      '</span><span class="iv">' +
      value +
      "</span></div>"
    );
  }

  function renderInspector() {
    if (!inspectorBody) return;
    lastInspectorPaint = performance.now();
    var b = selectedTrace ? branches.get(selectedTrace) : null;
    if (!b) {
      // Nothing selected: the pane says so rather than vanishing, because the
      // tab is still there and an empty box with no explanation is worse.
      inspectorBody.innerHTML = "";
      if (requestEmpty) requestEmpty.hidden = false;
      return;
    }
    if (requestEmpty) requestEmpty.hidden = true;

    var html = irow(
      "request",
      '<b style="color:#f4f7fb">' + esc(b.method + " " + b.path) + "</b>"
    );
    html += irow("state", esc(branchState(b)));
    html += irow(
      "status",
      b.error
        ? '<span class="bad">' + esc(b.error) + " (raised)</span>"
        : b.status == null
        ? "—"
        : esc(b.status)
    );
    html += irow(
      "duration",
      b.durationMs == null
        ? "—"
        : esc(b.durationMs) + "ms" + (isSlow(b) ? ' <span class="warn">⚠ slow</span>' : "")
    );
    html += irow(
      "zone",
      b.zone === "pool" ? "threadpool (worker thread)" : "event loop"
    );
    // For a sync endpoint the row total and the worker time are different
    // numbers, and the gap is the interesting one: time the request existed
    // without any thread working on it. We can measure the gap but not
    // attribute it — queueing for a free worker, ASGI overhead and a loop
    // frozen by someone else all land here — so it is named for what it
    // provably is and no cause is claimed.
    if (b.zone === "pool" && b.offloadMs && b.durationMs != null) {
      var offRow = Math.max(0, b.durationMs - b.offloadMs);
      html += irow("on a worker", esc(b.offloadMs) + "ms");
      if (offRow >= 5) {
        html += irow(
          "not on a worker",
          '<span class="warn">' + esc(offRow) + "ms</span> — queued for a thread, " +
            "framework overhead, or the loop was busy elsewhere"
        );
      }
    }
    html += irow("trace id", '<span class="sel">' + esc(b.traceId) + "</span>");
    if (b.requestId) {
      html += irow("x-request-id", '<span class="sel">' + esc(b.requestId) + "</span>");
    }
    // One request can span several asyncio tasks (create_task children inherit
    // the trace id). A THREADPOOL row legitimately has none — offloaded sync
    // work runs on a worker thread with no current task — so say that instead
    // of showing a bare 0 that reads as missing data.
    html += irow(
      "asyncio tasks",
      b.taskIds.size
        ? esc(b.taskIds.size)
        : b.zone === "pool"
        ? "0 — worker thread"
        : "—"
    );
    html += irow("call nodes", esc(b.nodesById.size));
    html += irow("suspends", esc(b.suspendCount));
    if (b.ioCalls.size) {
      var lines = b.ioDetails
        .map(function (d) {
          return esc(d.category) + (d.detail ? " " + esc(d.detail) : "");
        })
        .join("<br>");
      html += irow("blocking I/O", '<span class="bad">' + lines + "</span>");
    }
    if (!b.ioCalls.size && b.blocked) {
      html += irow(
        "cause",
        "unknown — no I/O detected. Either computation, or a wait we cannot " +
          "see (time.sleep, a read on an open socket)"
      );
    }
    if (b.blockSpans.length) {
      var spans = b.blockSpans
        .map(function (sp) {
          return (
            esc(sp.qualname) +
            " &mdash; " +
            (sp.ms == null ? "still running" : esc(sp.ms) + "ms")
          );
        })
        .join("<br>");
      html += irow(
        "held the loop",
        '<span class="bad">' +
          (b.blockedMs / 1000).toFixed(2) +
          "s total over " +
          b.blockSpans.length +
          (b.blockSpans.length === 1 ? " span" : " spans") +
          "<br>" +
          spans +
          "</span>"
      );
    } else {
      html += irow("held the loop", "none");
    }
    inspectorBody.innerHTML = html;
  }

  if (panelCollapse) {
    panelCollapse.addEventListener("click", function () {
      var min = panelEl.classList.toggle("min");
      panelCollapse.textContent = min ? "+" : "–";
      panelCollapse.setAttribute("aria-label", min ? "expand panel" : "minimize panel");
    });
  }
  selectTab("guide");
  renderInspector();
  // Assert the strip's starting state rather than relying on the `hidden`
  // attributes in the markup staying in step with this file.
  syncAlerts();

  // --- Keyboard ------------------------------------------------------------
  // Two keys, both earning their place by being something you do more than
  // once in a session. Stepping was the worst of it: every single step meant
  // moving the mouse back up to the header.
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var el = document.activeElement;
    var typing =
      el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

    if (e.key === "/" && !typing) {
      if (filterInput) {
        e.preventDefault();
        filterInput.focus();
        filterInput.select();
      }
      return;
    }
    if (e.key === "Escape" && typing && el === filterInput) {
      // Out of the filter without reaching for the mouse.
      filterInput.blur();
      return;
    }
    // Space steps — but never while a field has focus, or typing a space into
    // a filter term would silently advance the playback instead.
    if ((e.key === " " || e.key === "Spacebar") && !typing) {
      if (stepMode && stepBtn && !stepBtn.disabled) {
        e.preventDefault();
        doStep();
        render();
      }
    }
  });
})();
