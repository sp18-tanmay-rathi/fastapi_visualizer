// Pure geometry. No canvas, no state — just maths the renderer needs, which
// is what makes it the easiest thing in the frontend to reason about and test.
window.VIZ = window.VIZ || {};
(function (VIZ) {
  "use strict";

  // Where a straight segment from (fx,fy) towards (tx,ty) crosses the border
  // of the box centred on (cx,cy). Lets an edge stop ON the box instead of
  // running to its centre and disappearing underneath it.
  function clipToBox(fx, fy, tx, ty, cx, cy, hw, hh) {
    var dx = tx - fx, dy = ty - fy;
    if (!dx && !dy) return { x: fx, y: fy };
    var best = 1, i, t;
    var xs = [cx - hw, cx + hw], ys = [cy - hh, cy + hh];
    if (dx) {
      for (i = 0; i < 2; i++) {
        t = (xs[i] - fx) / dx;
        if (t > 0 && t <= 1 && Math.abs(fy + t * dy - cy) <= hh + 0.5) best = Math.min(best, t);
      }
    }
    if (dy) {
      for (i = 0; i < 2; i++) {
        t = (ys[i] - fy) / dy;
        if (t > 0 && t <= 1 && Math.abs(fx + t * dx - cx) <= hw + 0.5) best = Math.min(best, t);
      }
    }
    return { x: fx + dx * best, y: fy + dy * best };
  }

  VIZ.geometry = { clipToBox: clipToBox };
})(window.VIZ);
