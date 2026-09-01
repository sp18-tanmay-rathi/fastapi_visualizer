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

  var POOL_DEFAULT_TOTAL = 40;

  // Layout constants (all in unrotated/unscaled canvas px; each row computes
  // its own scale factor to fit its call tree into its band — see drawBranch).
  var NODE_W = 140;
  var NODE_H = 32;
  var NODE_SPACING_X = 150; // px per tree-depth level (deeper = further right)
  var SIBLING_GAP = 40; // baseline px between sibling slots within a row band
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
  var ZONE_MIN_FRAC = 0.26; // neither zone shrinks below this fraction
  var ZONE_MAX_FRAC = 0.74;

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
  var statusEl = document.getElementById("status");
  var statusTextEl = document.getElementById("status-text");
  var eventCountEl = document.getElementById("event-count");
  var dropWarnEl = document.getElementById("drop-warn");
  var dropCountEl = document.getElementById("drop-count");
  var multiWorkerWarnEl = document.getElementById("multi-worker-warn");
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

  // Blocking span freezing the EVENT LOOP (task 3), or null. Set on a
  // loop_blocked event with a real-time expiry (`until`); cleared in render()
  // when that expires (NOT by loop_unblocked — see the ingest note). While set,
  // the loop spine flashes red ("🔥 BLOCKED by <qualname> (Ns)") and the
  // offending node draws a hot red glow — surfacing the classic async failure:
  // sync/CPU work inside a coroutine stalling every other request.
  // { traceId, node_id, qualname, duration_ms, until }
  var loopBlocked = null;

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

  // Latest threadpool sample.
  var pool = { borrowed: 0, total: POOL_DEFAULT_TOTAL, queued: 0 };

  // Set true while drawing rows in the THREADPOOL zone: the whole zone already
  // means "on a worker thread", so the per-node "⇢ pool" stub is redundant
  // noise there and is suppressed.
  var poolZoneDraw = false;

  // --- Request cap / MAX ROWS KEPT -------------------------------------
  // Only up to MAX_REQ requests are KEPT on screen at once (header "max req"
  // control, default 10 — "max rows kept", since finished rows no longer free
  // themselves on a timer). When a brand-new trace shows up at the cap (see
  // getOrCreateBranch): the OLDEST (lowest seq) branch that is already `done`
  // is evicted to make room. If every kept branch is still live/in-flight,
  // there's no done row to sacrifice, so THIS event is dropped — but the trace
  // is NOT permanently blacklisted: its next event retries admission, so as
  // soon as one of the live rows finishes it gets a slot and appears. (An
  // earlier version added it to a sticky hidden set and dropped it forever,
  // which meant an over-cap request in a simultaneous burst never showed even
  // after the others completed.)
  var MAX_REQ = 10;

  // A trace can block the loop while still OVER the row cap (not yet admitted,
  // so its branch doesn't exist). Remember that here (traceId -> worst
  // blockedMs) so the durable "🔥 blocked" tag is applied when the trace is
  // finally admitted, instead of the blocking fact being lost.
  var blockedBefore = new Map();

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
    // Carry over a blocked tag recorded before this trace could be admitted.
    if (blockedBefore.has(traceId)) {
      b.blocked = true;
      b.blockedMs = blockedBefore.get(traceId);
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
        if (!b0) continue;
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
        var b2 = getOrCreateBranch(traceId);
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
          if (n5.awaiting) n5.awaitDone = true; // the await it was blocked on resolved
        }
        // Same per-frame rule as call_enter. `resume` carries no execution
        // tag, so consult the node recorded at call_enter; default to treating
        // it as loop work when the node is unknown (an event was shed).
        if (!n5 || n5.execution === "event_loop") loopHolder = traceId;
        continue;
      }

      if (ev.kind === "loop_blocked") {
        var bb = branches.get(traceId);
        var nb = bb && bb.nodesById.get(extra.node_id);
        var dur = extra.duration_ms || 0;
        var until =
          performance.now() +
          Math.max(BLOCK_FLASH_MIN_MS, Math.min(BLOCK_FLASH_MAX_MS, dur));
        if (bb) {
          bb.blocked = true; // persistent row tag (survives to DONE)
          bb.blockCount++;
          if (dur > bb.blockedMs) bb.blockedMs = dur;
        } else {
          // Trace blocked while still over the row cap (not admitted yet).
          // Stash it so the tag survives to when it IS admitted.
          blockedBefore.set(traceId, Math.max(dur, blockedBefore.get(traceId) || 0));
        }
        if (nb) {
          nb.blocking = true;
          nb.blockUntil = until;
        }
        loopBlocked = {
          traceId: traceId,
          node_id: extra.node_id,
          qualname: (nb && nb.qualname) || extra.qualname || "?",
          duration_ms: dur,
          until: until,
        };
        continue;
      }

      if (ev.kind === "loop_unblocked") {
        // Visual flash is time-driven (see BLOCK_FLASH_*), so we DON'T clear it
        // here — loop_unblocked arrives in the same drain as loop_blocked, and
        // clearing now would make the red invisible. The real-time expiry set
        // above (checked in render()/drawNode) ends the flash instead.
        continue;
      }

      if (ev.kind === "offload_start") {
        var bo = branches.get(traceId);
        if (bo) {
          bo.liveOffloads++;
          bo.offloadCount++;
          bo._offloadStartT.set(extra.node_id, ev.t);
          var no = bo.nodesById.get(extra.node_id);
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
      }
      if (ev.kind === "offload_start") {
        var b6 = branches.get(traceId);
        var n6 = b6 && b6.nodesById.get(extra.node_id);
        if (n6) n6.offloaded = true;
        continue;
      }

      if (ev.kind === "offload_end") {
        var be = branches.get(traceId);
        if (be) {
          be.liveOffloads = Math.max(0, be.liveOffloads - 1);
          var st = be._offloadStartT.get(extra.node_id);
          if (st != null) {
            be.offloadMs += Math.max(0, Math.round((ev.t - st) * 1000));
            be._offloadStartT.delete(extra.node_id);
          }
        }
        activeOffloads.delete(traceId + ":" + extra.node_id);
      }
      if (ev.kind === "offload_end") {
        var b7 = branches.get(traceId);
        var n7 = b7 && b7.nodesById.get(extra.node_id);
        if (n7) n7.offloaded = false;
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
  function resize() {
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    canvas.width = w;
    canvas.height = h;
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
  // Hit-test: map the click's Y (already screen-space, matching
  // currentRows[i].screenTop/height which had scrollY subtracted in
  // layoutRows) to the row it falls inside. ONE gesture does both: that row
  // becomes the inspector's subject and its call tree toggles open/closed.
  // X doesn't matter, only Y. A click that misses every row clears the
  // selection and closes the inspector.
  canvas.addEventListener("click", function (e) {
    var r = canvas.getBoundingClientRect();
    var clickY = e.clientY - r.top;
    for (var i = 0; i < currentRows.length; i++) {
      var row = currentRows[i];
      if (clickY >= row.screenTop && clickY <= row.screenTop + row.height) {
        row.branch.expanded = !row.branch.expanded;
        selectedTrace = row.branch.traceId;
        renderInspector();
        return;
      }
    }
    selectedTrace = null;
    renderInspector();
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
    if (b.error) return "#f85149";
    if (b.status != null && b.status >= 500) return "#f85149";
    if (b.status != null && b.status >= 400) return "#d29922";
    if (isSlow(b)) return "#d29922";
    return "#8b949e";
  }

  // --- Row filter (task 14) -----------------------------------------------
  // Space-separated terms, ANDed: `path:/checkout`, `status:500`, `slow:true`,
  // `zone:threadpool|pool|loop`. Anything without a `key:` is a plain
  // substring matched against the path and the trace id. Deliberately NOT a
  // query language — keyword/substring only.
  function parseFilter(text) {
    var terms = [];
    var raw = (text || "").trim().toLowerCase().split(/\s+/);
    for (var i = 0; i < raw.length; i++) {
      if (!raw[i]) continue;
      var c = raw[i].indexOf(":");
      if (c > 0) terms.push({ key: raw[i].slice(0, c), val: raw[i].slice(c + 1) });
      else terms.push({ key: "", val: raw[i] });
    }
    return terms;
  }

  function matchesTerm(b, t) {
    switch (t.key) {
      case "path":
        return (b.path || "").toLowerCase().indexOf(t.val) >= 0;
      case "status":
        return b.status != null && String(b.status) === t.val;
      case "slow":
        return t.val === "false" ? !isSlow(b) : isSlow(b);
      case "zone":
        return t.val === "loop" ? b.zone === "loop" : b.zone === "pool";
      case "":
        return (
          (b.path || "").toLowerCase().indexOf(t.val) >= 0 ||
          b.traceId.toLowerCase().indexOf(t.val) >= 0
        );
      default:
        return true; // unknown key: don't silently hide everything
    }
  }

  function matchesFilter(b) {
    for (var i = 0; i < filterTerms.length; i++) {
      if (!matchesTerm(b, filterTerms[i])) return false;
    }
    return true;
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
        var maxH = ROW_EXPANDED_MAX_FRAC * canvas.height;
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
    var x = canvas.width - 6;
    ctx.fillStyle = "#21262d";
    ctx.fillRect(x, trackTop, 4, trackH);
    ctx.fillStyle = "#484f58";
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
      ctx.fillStyle = i < borrowed ? (saturated ? "#f85149" : "#3fb950") : "#21262d";
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
  function drawZoneHeader(zone, band, list) {
    var liveCount = 0;
    for (var i = 0; i < list.length; i++) if (!list[i].done) liveCount++;

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    var ty = band.top + ZONE_HEADER_H / 2 - 6;
    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 12px monospace";
    if (zone === "loop") {
      ctx.fillText("EVENT LOOP", 12, ty);
      ctx.font = "10px monospace";
      ctx.fillStyle = "#8b949e";
      ctx.fillText(
        "1 thread · one runs at a time · " + liveCount + " live · " + list.length + " shown",
        12,
        ty + 14
      );
    } else {
      var total = pool.total || POOL_DEFAULT_TOTAL;
      var borrowed = pool.borrowed || 0;
      var saturated = borrowed >= total && total > 0;
      ctx.fillText("THREADPOOL", 12, ty);
      ctx.font = "10px monospace";
      ctx.fillStyle = saturated ? "#f85149" : "#8b949e";
      ctx.fillText(
        "worker threads · run in parallel · " + borrowed + "/" + total + " busy",
        12,
        ty + 14
      );
      // token grid, right-aligned in the header
      var gw = Math.min(220, canvas.width * 0.3);
      drawPoolGrid({ x: canvas.width - gw - 16, y: band.top + 8, w: gw, h: ZONE_HEADER_H - 16 });
    }
    ctx.textBaseline = "alphabetic";
  }

  // The zone's vertical spine + (loop zone only) the holder marker next to the
  // running row. A holder that has gone UNTRACED shows a dim hollow marker
  // instead of the bright glow — the loop is off in library code, and we say
  // so rather than implying this frame is still executing (task 4).
  function drawZoneSpine(zone, spine, rows) {
    ctx.save();
    ctx.strokeStyle = "#484f58";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(spine.x, spine.top);
    ctx.lineTo(spine.x, spine.bottom);
    ctx.stroke();
    ctx.restore();

    // Blocking flash (task 3): a coroutine is freezing the loop. Overpaint the
    // whole loop spine red + label; it takes precedence over the holder marker
    // (the block IS what's holding the loop, just not yielding).
    if (zone === "loop" && loopBlocked) {
      ctx.save();
      ctx.strokeStyle = "#f85149";
      ctx.shadowColor = "#f85149";
      ctx.shadowBlur = 12;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(spine.x, spine.top);
      ctx.lineTo(spine.x, spine.bottom);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = "#f85149";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      var secs = (loopBlocked.duration_ms / 1000).toFixed(2);
      ctx.fillText(
        "🔥 BLOCKED by " + loopBlocked.qualname + " (" + secs + "s)",
        spine.x + 10,
        spine.top + 2
      );
      ctx.restore();
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      return;
    }

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
      ctx.strokeStyle = "#8b949e";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(spine.x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#8b949e";
      ctx.font = "9px monospace";
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

  function drawDivider(y) {
    ctx.save();
    ctx.strokeStyle = "#30363d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
    ctx.restore();
  }

  function drawIdleHint(filteredOut) {
    ctx.fillStyle = "#6e7681";
    ctx.font = "13px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      filteredOut
        ? "every request is hidden by the current filter — clear the filter box"
        : "no in-flight requests — send some traffic to your app to see them here",
      canvas.width / 2,
      canvas.height / 2
    );
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function drawEdge(x0, y0, x1, y1, color, alpha, dashed, width) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1.5;
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }

  // Draw one node box plus edges to its children, recursively.
  function drawNode(node, x, y, w, h, scale, alpha, hue, activeId, pRect) {
    var isActive = node.id === activeId;
    var fill, borderColor;
    if (node.state === "suspended") {
      fill = "hsl(" + hue + ", 30%, 24%)";
      borderColor = "hsl(" + hue + ", 30%, 40%)";
    } else if (node.state === "done") {
      fill = "hsl(" + hue + ", 15%, 16%)";
      borderColor = "#30363d";
    } else {
      fill = "hsl(" + hue + ", 70%, 42%)";
      borderColor = "hsl(" + hue + ", 80%, 65%)";
    }

    ctx.save();
    ctx.globalAlpha = alpha;

    // Glow ring on the frame currently holding the loop.
    if (isActive) {
      ctx.save();
      ctx.shadowColor = "hsl(" + hue + ", 90%, 65%)";
      ctx.shadowBlur = 14;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "hsl(" + hue + ", 90%, 70%)";
      ctx.strokeRect(x - w / 2 - 3, y - h / 2 - 3, w + 6, h + 6);
      ctx.restore();
    }

    // Blocking span (task 3): this frame is running sync/CPU work that is
    // freezing the loop. Hot red glow, drawn over the holder ring so it wins.
    // Expires on the same real-time window as the spine flash.
    if (node.blocking && node.blockUntil && performance.now() > node.blockUntil) {
      node.blocking = false;
    }
    if (node.blocking) {
      ctx.save();
      ctx.shadowColor = "#f85149";
      ctx.shadowBlur = 18;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ff6a5f";
      ctx.strokeRect(x - w / 2 - 3, y - h / 2 - 3, w + 6, h + 6);
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
      ctx.strokeStyle = "#79c0ff";
      ctx.strokeRect(x - w / 2 - 5, y - h / 2 - 5, w + 10, h + 10);
      ctx.restore();
    }

    ctx.fillStyle = fill;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = node.isRoot ? 2 : 1;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);

    ctx.fillStyle = node.state === "done" ? "#6e7681" : "#e6edf3";
    ctx.font = Math.max(9, Math.round(11 * scale)) + "px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var label = truncate(node.qualname, Math.floor(18 / Math.max(scale, 0.5)));
    ctx.fillText(label, x, y);

    if (node.state === "suspended") {
      ctx.font = Math.max(9, Math.round(10 * scale)) + "px monospace";
      ctx.fillText("⏸", x + w / 2 - 10 * scale, y - h / 2 + 9 * scale);
    }
    // Finished request: green "✓ finished" tag under the request-root node.
    if (node.isRoot && node.state === "done") {
      ctx.fillStyle = "#3fb950";
      ctx.font = "bold " + Math.max(9, Math.round(10 * scale)) + "px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("✓ finished", x, y + h / 2 + 3);
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
      drawEdge(sx, sy, sx + stub, sy, "hsl(30, 90%, 60%)", alpha * 0.9, true, 1.5);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "hsl(30, 90%, 62%)";
      ctx.font = Math.max(8, Math.round(9 * scale)) + "px monospace";
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
    ctx.fillStyle = "#8b949e";
    ctx.font = Math.max(9, Math.round(11 * scale)) + "px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(isExpanded ? "▾" : "▸", rootX - (NODE_W * scale) / 2 - 10, rootY);
    ctx.restore();
  }

  // "[+N]" badge for the nodes hidden by the collapsed view.
  function drawBadge(x, y, n, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = "10px monospace";
    ctx.fillStyle = "#8b949e";
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
    RUNNING: { glyph: "●", color: "#3fb950", label: "RUNNING" },
    WAITING: { glyph: "○", color: "#8b949e", label: "WAITING" },
    UNTRACED: { glyph: "⋯", color: "#d29922", label: "UNTRACED" },
    WORKER: { glyph: "⇢", color: "#f0883e", label: "WAITING · worker" },
    DONE: { glyph: "✓", color: "#6e7681", label: "DONE" },
  };

  function drawRowHeader(b, state, rowY) {
    ctx.save();
    var y = rowY - NODE_H / 2 - 4;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    var x = ROOT_X - NODE_W / 2;

    // Gutter mark on the row the inspector is currently describing.
    if (selectedTrace === b.traceId) {
      ctx.font = "bold 11px monospace";
      ctx.fillStyle = "#58a6ff";
      ctx.fillText("▍", x - 9, y);
    }

    // Short id only — trace ids are 16 hex chars now; the full one is in the
    // inspector.
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = "hsl(" + b.hue + ", 60%, 72%)";
    var idText = "#" + b.shortId;
    ctx.fillText(idText, x, y);
    x += ctx.measureText(idText).width + 10;

    var st = STATE_STYLE[state] || STATE_STYLE.WAITING;
    ctx.font = "10px monospace";
    ctx.fillStyle = st.color;
    var stateText = st.glyph + " " + st.label;
    ctx.fillText(stateText, x, y);
    x += ctx.measureText(stateText).width + 12;

    // Outcome tag (task 14): "200 · 42ms", amber past the slow threshold, red
    // for 5xx or a raised exception — so a bad or slow request reads without
    // opening the inspector.
    var outcome = outcomeText(b);
    if (outcome) {
      ctx.fillStyle = outcomeColor(b);
      ctx.fillText(outcome, x, y);
      x += ctx.measureText(outcome).width + 12;
    }

    // Durable "⇢ pool" tag: this request handed work to a worker thread at
    // some point. The row never moves zones, and the pool-zone entry only
    // exists while the call runs — so without this a finished request shows
    // no sign it used a worker at all.
    if (b.offloadCount) {
      ctx.fillStyle = "hsl(30, 90%, 62%)";
      var ptag = "⇢ pool";
      if (b.offloadCount > 1) ptag += " ×" + b.offloadCount;
      if (b.offloadMs) ptag += " " + b.offloadMs + "ms";
      ctx.fillText(ptag, x, y);
      x += ctx.measureText(ptag).width + 12;
    }

    // Durable "blocked" tag: this request froze the loop at some point. Shown
    // alongside the live state (e.g. "✓ DONE  200 · 302ms  🔥 blocked 0.30s"),
    // so a finished request still records that it blocked — not just a flash.
    if (b.blocked) {
      ctx.fillStyle = "#f85149";
      var tag = "🔥 blocked";
      if (b.blockedMs) tag += " " + (b.blockedMs / 1000).toFixed(2) + "s";
      ctx.fillText(tag, x, y);
    }

    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  function drawBranchCollapsed(b, spine, rowY, alpha, activeId, holds) {
    var chain = [b.rootNode];
    for (var i = 0; i < b.stack.length; i++) {
      var n = b.nodesById.get(b.stack[i]);
      if (n) chain.push(n);
    }
    var maxDepth = chain.length - 1;
    var availW = canvas.width - ROOT_X - MARGIN;
    var scaleX = maxDepth > 0 ? Math.min(1, availW / (maxDepth * NODE_SPACING_X)) : 1;
    var scale = Math.max(MIN_SCALE, scaleX);

    var prevX = spine.x;
    var lastX = ROOT_X;

    for (var c = 0; c < chain.length; c++) {
      var node = chain[c];
      var x = ROOT_X + c * NODE_SPACING_X * scale;
      var edgeColor = "hsl(" + b.hue + ", 60%, 50%)";

      if (node.isRoot) {
        drawEdge(
          spine.x,
          rowY,
          x,
          rowY,
          holds ? "hsl(" + b.hue + ", 90%, 65%)" : edgeColor,
          alpha * (holds ? 1 : 0.45),
          !holds,
          holds ? 2.5 : 1.5
        );
      } else {
        var edgeAlpha = alpha;
        var dashed = false;
        if (node.state === "suspended" && !node.offloaded) {
          edgeAlpha = alpha * 0.3;
          dashed = true;
        }
        drawEdge(prevX, rowY, x, rowY, edgeColor, edgeAlpha, dashed, 1.5);
      }

      drawNode(node, x, rowY, NODE_W * scale, NODE_H * scale, scale, alpha, b.hue, activeId, null);
      prevX = x;
      lastX = x;
    }

    drawExpandArrow(ROOT_X, rowY, scale, false);

    var drawnFromNodesById = chain.length - 1; // chain minus the synthetic root
    var hidden = b.nodesById.size - drawnFromNodesById;
    if (hidden > 0) {
      drawBadge(lastX + (NODE_W * scale) / 2 + 10, rowY, hidden, alpha);
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

    var availW = canvas.width - ROOT_X - MARGIN;
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
        drawEdge(
          spine.x,
          rowY,
          p.x,
          p.y,
          holds ? "hsl(" + b.hue + ", 90%, 65%)" : edgeColor,
          alpha * (holds ? 1 : 0.45),
          !holds,
          holds ? 2.5 : 1.5
        );
        rootPos = p;
      } else if (parentPos) {
        // A suspended node's edge up to its parent goes faint — "parked".
        if (node.state === "suspended" && !node.offloaded) {
          edgeAlpha = alpha * 0.3;
          dashed = true;
        }
        drawEdge(parentPos.x, parentPos.y, p.x, p.y, edgeColor, edgeAlpha, dashed, 1.5);
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
        null
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

    drawEdge(spine.x, rowY, x - w / 2, rowY, "hsl(30, 90%, 60%)", 0.9, true, 1.5);

    ctx.save();
    ctx.fillStyle = "hsl(" + item.hue + ", 55%, 26%)";
    ctx.strokeStyle = "hsl(30, 90%, 55%)";
    ctx.lineWidth = 1.5;
    ctx.fillRect(x - w / 2, rowY - h / 2, w, h);
    ctx.strokeRect(x - w / 2, rowY - h / 2, w, h);
    ctx.fillStyle = "#e6edf3";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(truncate(item.qualname, 18), x, rowY);
    ctx.restore();

    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    var ty = rowY - h / 2 - 4;
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = "hsl(" + item.hue + ", 60%, 72%)";
    var idText = "#" + item.shortId;
    ctx.fillText(idText, x - w / 2, ty);
    ctx.font = "10px monospace";
    ctx.fillStyle = "#f0883e";
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
        ctx.font = "11px monospace";
        var w = Math.max.apply(
          null,
          lines.map(function (l) {
            return ctx.measureText(l).width;
          })
        ) + 12;
        var h = lines.length * 14 + 8;
        var tx = Math.min(mouseX + 12, canvas.width - w - 4);
        var ty = Math.min(mouseY + 12, canvas.height - h - 4);
        ctx.fillStyle = "#161b22";
        ctx.strokeStyle = "#30363d";
        ctx.fillRect(tx, ty, w, h);
        ctx.strokeRect(tx, ty, w, h);
        ctx.fillStyle = "#e6edf3";
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
    var spineBottom = Math.max(spineTop + 20, band.bottom);
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
    ctx.rect(0, spineTop - 2, canvas.width, bandRowsH + 4);
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

    // Expire the blocking flash on its real-time window (see BLOCK_FLASH_*).
    if (loopBlocked && performance.now() > loopBlocked.until) loopBlocked = null;

    // Resolve the hovered qualname from LAST frame's rects, before they are
    // cleared below — drawNode needs it while drawing THIS frame.
    hoverQual = qualnameAt(mouseX, mouseY);

    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    var bottom = canvas.height - ZONE_BOTTOM_MARGIN;
    var avail = Math.max(40, bottom - top);
    var n = loopList.length + poolList.length + poolWork.length;
    var frac = n === 0 ? 0.5 : loopList.length / n;
    frac = Math.max(ZONE_MIN_FRAC, Math.min(ZONE_MAX_FRAC, frac));
    dividerY = top + frac * avail;

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
      drawIdleHint(branches.size > 0);
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
    MAX_REQ = Math.max(1, Math.min(50, parseInt(maxReqInput.value, 10) || 10));
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
      pending = [];
      loopHolder = null;
      loopBlocked = null;
      selectedTrace = null;
      scrollLoop = 0;
      scrollPool = 0;
      droppedCount = 0;
      if (dropCountEl) dropCountEl.textContent = "0";
      if (dropWarnEl) dropWarnEl.hidden = true;
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
  var inspectorEl = document.getElementById("inspector");
  var inspectorBody = document.getElementById("inspector-body");
  var inspectorTitle = document.getElementById("inspector-title");
  var inspectorToggle = document.getElementById("inspector-toggle");
  var inspectorHead = document.getElementById("inspector-head");

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
    if (!inspectorEl || !inspectorBody) return;
    lastInspectorPaint = performance.now();
    var b = selectedTrace ? branches.get(selectedTrace) : null;
    if (!b) {
      inspectorEl.hidden = true;
      return;
    }
    inspectorEl.hidden = false;
    if (inspectorTitle) {
      inspectorTitle.textContent = "#" + b.shortId + "  " + b.method + " " + b.path;
    }

    var html = "";
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
    html += irow(
      "blocking",
      b.blockCount
        ? '<span class="bad">' +
          esc(b.blockCount) +
          " span(s), worst " +
          (b.blockedMs / 1000).toFixed(2) +
          "s</span>"
        : "none"
    );
    inspectorBody.innerHTML = html;
  }

  function toggleInspector(e) {
    if (!inspectorEl) return;
    if (e) e.stopPropagation();
    var min = inspectorEl.classList.toggle("min");
    if (inspectorToggle) inspectorToggle.textContent = min ? "+" : "–";
  }
  if (inspectorHead) inspectorHead.addEventListener("click", toggleInspector);
  renderInspector();

  // Intern helper panel: minimize/expand by toggling the .min class; clicking
  // anywhere on its header bar toggles too (the whole bar is the hit target).
  var legendEl = document.getElementById("legend");
  var legendHead = document.getElementById("legend-head");
  var legendToggle = document.getElementById("legend-toggle");
  function toggleLegend() {
    if (!legendEl) return;
    var min = legendEl.classList.toggle("min");
    if (legendToggle) legendToggle.textContent = min ? "+" : "–";
  }
  if (legendHead) legendHead.addEventListener("click", toggleLegend);
})();
