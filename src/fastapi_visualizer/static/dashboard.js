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
  var SPINE_TOP = 56; // y where the spine begins (below its label block)
  var SPINE_BOTTOM_MARGIN = 20; // gap from spine bottom to canvas bottom
  var ROOT_X = SPINE_X + 90; // x where each row's request-root node sits
  var ROW_BAND_FILL = 0.8; // fraction of a row's band height siblings may use
  var MIN_SCALE = 0.35;

  // Per-row sizing (see "variable-height row stacking" in render()/layoutRows()).
  var ROW_COLLAPSED_H = 64; // collapsed row: just a chain, always this tall
  var ROW_EXPANDED_MIN = 180; // expanded row: never smaller than this
  var ROW_EXPANDED_MAX_FRAC = 0.6; // ...nor taller than this fraction of the viewport
  var ROW_GAP = 8; // breathing room between stacked rows

  var canvas = document.getElementById("viz");
  var ctx = canvas.getContext("2d");
  var statusEl = document.getElementById("status");
  var statusTextEl = document.getElementById("status-text");
  var eventCountEl = document.getElementById("event-count");

  var eventCount = 0;

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

  // Latest threadpool sample.
  var pool = { borrowed: 0, total: POOL_DEFAULT_TOTAL, queued: 0 };

  // --- Request cap / MAX ROWS KEPT -------------------------------------
  // Only up to MAX_REQ requests are ever KEPT on screen at once (header
  // "max req" control, default 10 — now means "max rows kept", since
  // finished rows no longer free themselves on a timer). When a brand-new
  // trace shows up and we're already at the cap (see getOrCreateBranch):
  // the OLDEST (lowest seq) branch that is already `done` is evicted to
  // make room. If every kept branch is still live/in-flight, there's no
  // done row to sacrifice, so the new trace is added to hiddenTraces and
  // every subsequent event for it is dropped on the floor (still fine to
  // count it toward the event counter). "clear" (see #ld-clear handler)
  // wipes hiddenTraces too, so previously-hidden traces don't reappear.
  var MAX_REQ = 10;
  var hiddenTraces = new Set(); // trace_ids we decided not to display

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
  var INIT_LOOKBACK = 3; // on connect, start ~this many s before newest (skip stale backlog)
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

    if (pending.length === 0) {
      // Idle: collapse the gap so the next burst plays from its start, not
      // after a long empty stretch.
      if (virtualT === null || virtualT < maxSeenT) virtualT = maxSeenT;
      return;
    }
    if (virtualT === null) {
      // Begin near live: skip any stale backlog frame sent on connect.
      virtualT = Math.max(pending[0].t, maxSeenT - INIT_LOOKBACK);
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

  // Drain buffered events one at a time until the loop hand-off completes:
  // apply events in order and stop as soon as loopHolder becomes a NEW,
  // non-null trace (different from whichever trace held it — or didn't —
  // right before this click). A suspend that merely clears loopHolder to
  // null does not count as a stop point; we keep draining through that until
  // an actual new holder takes over, so one click = one hand-off of the loop
  // from one request to the next. If the buffer runs dry first, we just stop
  // there (apply what's there).
  function doStep() {
    var before = loopHolder;
    var applied = 0;
    while (applied < pending.length) {
      var ev = pending[applied];
      ingest([ev]);
      applied++;
      virtualT = ev.t;
      if (loopHolder !== before && loopHolder !== null) break;
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
    if (hiddenTraces.has(traceId)) return null;

    // At cap: evict the OLDEST done branch (lowest seq) to make room for
    // this new trace. If nothing kept is done (all still in-flight), there's
    // no safe row to give up — hide the new trace instead, same as the old
    // over-cap behavior.
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
        hiddenTraces.add(traceId);
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
    };
    b.rootNode = {
      id: "root:" + traceId,
      qualname: "? ?",
      state: "running",
      children: [],
      isRoot: true,
    };
    branches.set(traceId, b);
    return b;
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
      if (hiddenTraces.has(traceId)) continue; // over the request cap: ignore

      if (ev.kind === "request_start") {
        var b0 = getOrCreateBranch(traceId);
        if (!b0) continue;
        b0.method = extra.method || "?";
        b0.path = extra.path || "?";
        b0.rootNode.qualname = b0.method + " " + b0.path;
        continue;
      }

      if (ev.kind === "request_end") {
        var b1 = branches.get(traceId);
        if (b1) {
          b1.done = true;
          b1.doneAt = ev.t;
          // Grey out the request-root node too, so a finished branch reads
          // as done at a glance (persists on screen — see note above).
          b1.rootNode.state = "done";
        }
        continue;
      }

      if (ev.kind === "call_enter") {
        var b2 = getOrCreateBranch(traceId);
        if (!b2) continue;
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
          state: "running",
          offloaded: false,
          children: [],
        };
        b2.nodesById.set(extra.node_id, node);
        parent.children.push(node);
        b2.stack.push(extra.node_id);
        // Entering a frame means this trace is actively running on the loop.
        loopHolder = traceId;
        continue;
      }

      if (ev.kind === "call_exit") {
        var b3 = branches.get(traceId);
        if (!b3) continue;
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
        var n5 = b5.nodesById.get(extra.node_id);
        if (n5) {
          n5.state = "running";
          if (n5.awaiting) n5.awaitDone = true; // the await it was blocked on resolved
        }
        loopHolder = traceId;
        continue;
      }

      if (ev.kind === "offload_start") {
        var b6 = branches.get(traceId);
        var n6 = b6 && b6.nodesById.get(extra.node_id);
        if (n6) n6.offloaded = true;
        continue;
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

  function resize() {
    var header = document.querySelector("header");
    var headerH = header ? header.offsetHeight : 0;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - headerH;
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

  // --- Vertical scroll (rows can outgrow the viewport once expanded, or once
  // there are ~10 of them) --------------------------------------------------
  // scrollY is in CONTENT space (0 = top row flush with the spine label).
  // render()/layoutRows() clamps it to [0, contentHeight - canvas.height]
  // every frame (content can shrink as branches finish, so re-clamping only
  // on wheel input isn't enough). Row screen positions are simply
  // contentY - scrollY; see layoutRows().
  var scrollY = 0;
  canvas.addEventListener(
    "wheel",
    function (e) {
      scrollY += e.deltaY;
      e.preventDefault();
    },
    { passive: false }
  );

  // Row layout from the last frame (screen-space top/height per branch),
  // used by both the scrollbar and the click-to-toggle handler below.
  var currentRows = [];

  // --- Click-to-expand/collapse -------------------------------------------
  // Hit-test: map the click's Y (already screen-space, matching
  // currentRows[i].screenTop/height which had scrollY subtracted in
  // layoutRows) to the row it falls inside, and flip that branch's
  // `expanded` flag. Whole-row click works, not just the "▸"/"▾" glyph —
  // per the spec, X doesn't matter, only Y.
  canvas.addEventListener("click", function (e) {
    var r = canvas.getBoundingClientRect();
    var clickY = e.clientY - r.top;
    for (var i = 0; i < currentRows.length; i++) {
      var row = currentRows[i];
      if (clickY >= row.screenTop && clickY <= row.screenTop + row.height) {
        row.branch.expanded = !row.branch.expanded;
        break;
      }
    }
  });

  // The vertical spine's extent, recomputed every frame from canvas size.
  function spineGeometry() {
    var top = SPINE_TOP;
    var bottom = Math.max(top + 40, canvas.height - SPINE_BOTTOM_MARGIN);
    return { x: SPINE_X, top: top, bottom: bottom };
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
  function layoutRows() {
    var order = [];
    branches.forEach(function (b) {
      order.push(b);
    });
    order.sort(function (a, b) {
      return a.seq - b.seq;
    });

    var metrics = new Map(); // traceId -> {leafCount, maxDepth}, expanded rows only
    var rows = [];
    var y = SPINE_TOP; // content-space cursor; SPINE_TOP is the "top offset below the spine label"
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
    var contentHeight = y + SPINE_BOTTOM_MARGIN; // + bottom padding

    // Clamp scroll to what's actually scrollable; content can shrink (a
    // branch finishes/collapses) so this has to happen every frame, not just
    // on wheel input.
    var maxScroll = Math.max(0, contentHeight - canvas.height);
    scrollY = Math.max(0, Math.min(scrollY, maxScroll));

    for (var j = 0; j < rows.length; j++) {
      rows[j].screenTop = rows[j].contentTop - scrollY;
      rows[j].screenCenter = rows[j].contentCenter - scrollY;
    }

    return { rows: rows, metrics: metrics, contentHeight: contentHeight, maxScroll: maxScroll };
  }

  // Thin scrollbar on the right edge, only drawn when the row stack overflows
  // the viewport. Track spans the spine's visible extent; thumb size/position
  // mirror scrollY/maxScroll the same way a native scrollbar would.
  function drawScrollbar(spine, maxScroll, contentHeight) {
    if (maxScroll <= 0) return;
    var trackTop = spine.top;
    var trackH = spine.bottom - spine.top;
    var thumbH = Math.max(24, trackH * (canvas.height / contentHeight));
    var thumbY = trackTop + (scrollY / maxScroll) * (trackH - thumbH);
    var x = canvas.width - 6;
    ctx.fillStyle = "#21262d";
    ctx.fillRect(x, trackTop, 4, trackH);
    ctx.fillStyle = "#484f58";
    ctx.fillRect(x, thumbY, 4, thumbH);
  }

  function poolRect() {
    var w = 168;
    var h = 118;
    // Bottom-right, out of the way of the row bands which grow rightward
    // from the spine on the left.
    return { x: canvas.width - w - 16, y: canvas.height - h - 16, w: w, h: h };
  }

  function drawThreadpool() {
    var r = poolRect();
    var total = pool.total || POOL_DEFAULT_TOTAL;
    var borrowed = pool.borrowed || 0;
    var saturated = borrowed >= total && total > 0;

    ctx.fillStyle = "#161b22";
    ctx.strokeStyle = "#30363d";
    ctx.lineWidth = 1;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    ctx.fillStyle = saturated ? "#f85149" : "#8b949e";
    ctx.font = "11px monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(
      "THREADPOOL " + borrowed + "/" + total,
      r.x + 8,
      r.y + 6
    );

    var padding = 8;
    var gridTop = r.y + 24;
    var gridW = r.w - padding * 2;
    var gridH = r.h - 24 - padding;
    var cols = Math.min(total, 10) || 1;
    var rows = Math.ceil(total / cols) || 1;
    var gap = 3;
    var cellW = (gridW - gap * (cols - 1)) / cols;
    var cellH = (gridH - gap * (rows - 1)) / rows;
    var cellSize = Math.max(3, Math.min(cellW, cellH));

    for (var i = 0; i < total; i++) {
      var col = i % cols;
      var row = Math.floor(i / cols);
      var x = r.x + padding + col * (cellSize + gap);
      var y = gridTop + row * (cellSize + gap);
      ctx.fillStyle = i < borrowed ? (saturated ? "#f85149" : "#3fb950") : "#21262d";
      ctx.fillRect(x, y, cellSize, cellSize);
    }
    return r;
  }

  // Draw the event-loop spine: the vertical bar itself, its label block, and
  // a glowing marker next to the row of whichever request currently holds
  // the loop (so "who's running right now" reads at a glance). The spine
  // always spans the visible viewport (it doesn't scroll); the marker's Y
  // comes from the holder's already-scrolled row position, so it stays next
  // to the right row even when that row has scrolled — and is skipped
  // entirely if the row has scrolled out of view.
  function drawSpine(spine, rows, liveCount, totalCount) {
    ctx.save();
    ctx.strokeStyle = "#484f58";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(spine.x, spine.top);
    ctx.lineTo(spine.x, spine.bottom);
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 12px monospace";
    ctx.fillText("EVENT LOOP", spine.x, 18);
    ctx.font = "10px monospace";
    ctx.fillStyle = "#8b949e";
    ctx.fillText("(1 thread)", spine.x, 32);
    // liveCount = still in-flight, totalCount = every kept row (done ones
    // persist until evicted/cleared — see the "clear" button + row cap).
    ctx.fillText(liveCount + " live · " + totalCount + " shown", spine.x, 46);

    if (loopHolder) {
      var hb = branches.get(loopHolder);
      var holderRow = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].branch.traceId === loopHolder) {
          holderRow = rows[i];
          break;
        }
      }
      if (hb && holderRow) {
        var y = holderRow.screenCenter;
        if (y >= spine.top - 10 && y <= spine.bottom + 10) {
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
    }

    ctx.textAlign = "left";
  }

  function drawIdleHint() {
    ctx.fillStyle = "#6e7681";
    ctx.font = "13px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "no in-flight requests — send some traffic to your app to see them here",
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
    if (node.offloaded) {
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
  // Intern-friendly legend + one-line explainer, pinned bottom-left. Explains
  // the whole picture in plain language: the single loop, the glyphs, the id.
  function drawLegend() {
    var rows = [
      { c: "hsl(210,70%,50%)", box: true, t: "running on the event loop (this request is executing now)" },
      { c: "hsl(210,80%,70%)", ring: true, t: "glowing ring = currently HOLDS the loop" },
      { c: "hsl(210,30%,40%)", box: true, dim: true, t: "⏸ waiting at an await (paused, loop moved on)" },
      { c: "hsl(30,90%,60%)", stub: true, t: "⇢ pool = blocking/sync work sent to a worker thread" },
      { c: "#3fb950", check: true, t: "✓ finished = request completed (stays until you clear)" },
      { c: "#8b949e", id: true, t: "#id = each request's unique id  ·  a row = one request" },
    ];
    var pad = 10, lh = 18, sw = 22;
    var title = "One event loop, one thread — only ONE request runs at a time; the rest wait at an await.";
    ctx.font = "11px monospace";
    var boxW = 430;
    var boxH = pad * 2 + 16 + rows.length * lh;
    var x0 = 14;
    var y0 = canvas.height - boxH - 14;

    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "#0d1117";
    ctx.strokeStyle = "#30363d";
    ctx.lineWidth = 1;
    ctx.fillRect(x0, y0, boxW, boxH);
    ctx.strokeRect(x0, y0, boxW, boxH);

    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(title, x0 + pad, y0 + pad);

    var ty = y0 + pad + 18;
    ctx.font = "11px monospace";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var sx = x0 + pad;
      var sy = ty + i * lh;
      // swatch
      ctx.fillStyle = r.c;
      if (r.stub) {
        ctx.strokeStyle = r.c;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(sx, sy + 7);
        ctx.lineTo(sx + sw, sy + 7);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (r.check || r.id) {
        ctx.fillText(r.check ? "✓" : "#", sx + 4, sy);
      } else {
        ctx.fillRect(sx, sy + 1, 14, 12);
        if (r.ring) {
          ctx.strokeStyle = r.c;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sx - 2, sy - 1, 18, 16);
        }
      }
      ctx.fillStyle = "#c9d1d9";
      ctx.fillText(r.t, sx + sw + 6, sy);
    }
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  // Small "#id" tag above a request's root node so each concurrent request is
  // identifiable by its short random id (from the backend trace_id).
  function drawRequestId(b, rowY) {
    ctx.save();
    ctx.fillStyle = "hsl(" + b.hue + ", 60%, 72%)";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("#" + b.traceId, ROOT_X - NODE_W / 2, rowY - NODE_H / 2 - 4);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  function drawBranchCollapsed(b, spine, rowY, pRect, alpha) {
    var chain = [b.rootNode];
    for (var i = 0; i < b.stack.length; i++) {
      var n = b.nodesById.get(b.stack[i]);
      if (n) chain.push(n);
    }
    var maxDepth = chain.length - 1;
    var availW = canvas.width - ROOT_X - MARGIN;
    var scaleX = maxDepth > 0 ? Math.min(1, availW / (maxDepth * NODE_SPACING_X)) : 1;
    var scale = Math.max(MIN_SCALE, scaleX);

    var activeId = loopHolder === b.traceId ? b.stack[b.stack.length - 1] : null;
    var prevX = spine.x;
    var lastX = ROOT_X;

    for (var c = 0; c < chain.length; c++) {
      var node = chain[c];
      var x = ROOT_X + c * NODE_SPACING_X * scale;
      var edgeColor = "hsl(" + b.hue + ", 60%, 50%)";

      if (node.isRoot) {
        var holds = loopHolder === b.traceId;
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

      drawNode(node, x, rowY, NODE_W * scale, NODE_H * scale, scale, alpha, b.hue, activeId, pRect);
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
  function drawBranchExpanded(b, spine, rowY, rowHeight, pRect, alpha, metrics) {
    var leafCount = metrics.leafCount;
    var maxDepth = metrics.maxDepth;

    var availW = canvas.width - ROOT_X - MARGIN;
    var scaleX = maxDepth > 0 ? Math.min(1, availW / (maxDepth * NODE_SPACING_X)) : 1;
    var neededH = leafCount * SIBLING_GAP;
    var scaleY = Math.min(1, (rowHeight * ROW_BAND_FILL) / Math.max(1, neededH));
    var scale = Math.max(MIN_SCALE, Math.min(1, scaleX, scaleY));

    var activeId = loopHolder === b.traceId ? b.stack[b.stack.length - 1] : null;
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
        // this row holds the loop, faint + dashed while it's parked.
        var holds = loopHolder === b.traceId;
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
        pRect
      );

      for (var i = 0; i < node.children.length; i++) {
        walk(node.children[i], p);
      }
    }

    walk(b.rootNode, null);
    if (rootPos) drawExpandArrow(rootPos.x, rootPos.y, scale, true);
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

  function render() {
    advancePlayback();

    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    hoverRects = [];
    // Threadpool cluster + its rect are computed/drawn in plain screen space
    // and never touched by scrollY — it's meant to stay pinned to its corner
    // regardless of how far the request rows have scrolled. Row nodes are
    // already laid out in screen space too (see layoutRows), so the dashed
    // offload edges drawn from a node to pRect (in drawNode) just work with
    // no extra translation.
    var pRect = drawThreadpool();
    var spine = spineGeometry();
    var layout = layoutRows();
    currentRows = layout.rows; // for the click handler + scrollbar, outside this frame

    // "live" = still in-flight (not done); "shown" = every kept branch,
    // done or not — done branches persist until evicted/cleared.
    var liveCount = 0;
    branches.forEach(function (b) {
      if (!b.done) liveCount++;
    });
    drawSpine(spine, layout.rows, liveCount, branches.size);

    if (branches.size === 0) {
      drawIdleHint();
    } else {
      for (var i = 0; i < layout.rows.length; i++) {
        var row = layout.rows[i];
        var b = row.branch;
        // Finished branches no longer fade — they stay at full opacity
        // (their nodes render in the muted "done" styling instead; see
        // request_end in ingest() and drawNode's node.state handling).
        var alpha = 1;
        if (b.expanded) {
          drawBranchExpanded(b, spine, row.screenCenter, row.height, pRect, alpha, layout.metrics.get(b.traceId));
        } else {
          drawBranchCollapsed(b, spine, row.screenCenter, pRect, alpha);
        }
        drawRequestId(b, row.screenCenter);
      }
    }

    drawScrollbar(spine, layout.maxScroll, layout.contentHeight);
    drawLegend();
    drawTooltip();
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // --- WebSocket -----------------------------------------------------

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/_viz/ws");

    ws.onopen = function () {
      statusEl.classList.add("connected");
      statusTextEl.textContent = "connected";
      // Re-arm backlog skipping for this (re)connection.
      sawFirstFrame = false;
      connectBaselineT = -Infinity;
    };
    ws.onmessage = function (msg) {
      try {
        var frame = JSON.parse(msg.data);
        if (!frame.events) return;
        if (!sawFirstFrame) {
          // First frame IS the backlog snapshot. Set the live edge to its
          // newest timestamp and drop it; only newer events get animated.
          sawFirstFrame = true;
          for (var k = 0; k < frame.events.length; k++) {
            if (frame.events[k].t > connectBaselineT) connectBaselineT = frame.events[k].t;
          }
          return;
        }
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
      hiddenTraces.clear();
      pending = [];
      loopHolder = null;
      scrollY = 0;
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
})();
