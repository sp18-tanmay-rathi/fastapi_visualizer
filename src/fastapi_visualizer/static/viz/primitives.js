// Canvas drawing primitives: rounded rectangles, state chips, arrowed edges.
//
// Bound to one context by `VIZ.primitives(ctx, theme, nodeW, nodeH)` rather
// than taking a ctx per call, so the renderer's call sites stay unchanged.
window.VIZ = window.VIZ || {};
(function (VIZ) {
  "use strict";

  VIZ.primitives = function (ctx, T, NODE_W, NODE_H) {
    var MONO = T.mono;
    var ARROW_HEAD = T.arrowHead;
    var clipToBox = VIZ.geometry.clipToBox;

    // A rounded rectangle path. Canvas has `roundRect` on newer browsers only,
    // and this has to work offline on whatever the developer has open.
    function roundRectPath(x, y, w, h, r) {
      if (!r) { ctx.rect(x, y, w, h); return; }
      r = Math.min(r, w / 2, h / 2);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }


    // A state chip: a short label on a tinted ground. The tint is what makes a
    // 10px glyph findable on a near-black canvas — the old bare emoji at 9px
    // rendered differently on every OS and turned to mud.
    function drawChip(x, y, text, color, size) {
      size = size || T.fs.tag;
      ctx.save();
      ctx.font = "600 " + size + "px " + MONO;
      var pad = 6;
      var w = ctx.measureText(text).width + pad * 2;
      var h = size + 8;
      ctx.fillStyle = tint(color, 0.16);
      ctx.beginPath();
      roundRectPath(x, y - h / 2, w, h, 3);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x + pad, y + 0.5);
      ctx.restore();
      return w;
    }

    // #rrggbb -> rgba(...). Only ever called with theme literals.
    function tint(hex, a) {
      var v = parseInt(hex.slice(1), 16);
      return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")";
    }

    // An edge from one node to another.
    //
    // `head` draws an arrowhead at the far end, and callers pass endpoints ON
    // the two boxes' borders (see clipToBox) rather than their centres. Running
    // centre-to-centre hid both ends under the boxes, so a connector said that
    // two nodes were related but never which way the call went.
    function drawEdge(x0, y0, x1, y1, color, alpha, dashed, width, head) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width || 1.5;
      ctx.lineCap = "round";
      var hl = head ? ARROW_HEAD : 0;
      var ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.beginPath();
      if (dashed) ctx.setLineDash([4, 4]);
      ctx.moveTo(x0, y0);
      // Stop just short of the head so a dashed line does not print through it.
      ctx.lineTo(x1 - Math.cos(ang) * hl * 0.85, y1 - Math.sin(ang) * hl * 0.85);
      ctx.stroke();
      if (head) {
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - Math.cos(ang - 0.42) * hl, y1 - Math.sin(ang - 0.42) * hl);
        ctx.lineTo(x1 - Math.cos(ang + 0.42) * hl, y1 - Math.sin(ang + 0.42) * hl);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // An edge between two node boxes: clipped to both borders, with a head.
    function drawNodeEdge(px, py, cx, cy, color, alpha, dashed) {
      var a = clipToBox(px, py, cx, cy, px, py, NODE_W / 2, NODE_H / 2);
      var b = clipToBox(cx, cy, px, py, cx, cy, NODE_W / 2, NODE_H / 2);
      drawEdge(a.x, a.y, b.x, b.y, color, alpha, dashed, 1.6, true);
    }

    return {
      roundRectPath: roundRectPath,
      drawChip: drawChip,
      drawEdge: drawEdge,
      drawNodeEdge: drawNodeEdge,
      tint: tint,
    };
  };
})(window.VIZ);
