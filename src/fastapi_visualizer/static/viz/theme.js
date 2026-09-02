// Theme tokens for the canvas — every colour, type size and radius it draws
// with. Pure data, no behaviour, so it lifts out of the renderer cleanly and
// is the one file to open when the look needs changing.
//
// Loaded before dashboard.js; see index.html for the order.
window.VIZ = window.VIZ || {};
(function (VIZ) {
  "use strict";

  // ---------------------------------------------------------------------
  // THEME — every colour, type size and radius the canvas draws with.
  //
  // Direction B, "Instrument": a near-black ground with slate node bodies,
  // where a node's STATE is carried by a 4px left stripe rather than by
  // flooding the whole box with colour. That is the substantive change, not a
  // recolour: a label on a saturated fill is the reason the old canvas read as
  // mushy, and no amount of adjusting the fill fixes it. On a dark body the
  // label sits at full contrast and the stripe still says the state.
  //
  // Contrast measured against `bg`. The three greys the old palette leaned on
  // scored 2.26:1 (spine — effectively invisible), 4.02:1 (below AA at 9-13px)
  // and 6.38:1 (fine, but set at 9px). Each moves up a step here, and every
  // type size goes up 1-2px.
  //
  // Kept as one object so there is a single place to change the look, and so
  // it lifts out into its own file cleanly.
  VIZ.theme = {
    bg:         "#08090c",
    zoneBg:     "#0e1116",  // faint band behind a zone, so zones read as areas
    panel:      "#12151b",  // tooltips, the divider grip
    track:      "#191d25",  // scrollbar trough
    line:       "#39414e",  // borders, rules

    spine:      "#7d8899",  // 5.9:1 — was #484f58 at 2.26:1
    spineLive:  "#b9c2ce",  // the stretch of spine that is actually holding
    ink:        "#f4f7fb",  // 16.8:1
    dim:        "#b9c2ce",  // 9.4:1 — was #8b949e at 6.38:1
    faint:      "#8892a1",  // 5.5:1 — was #6e7681 at 4.02:1

    ok:         "#3ddc84",
    info:       "#56a8ff",
    warn:       "#ffb224",
    bad:        "#ff5c54",
    badHot:     "#ff7b73",  // the live "frozen right now" ring
    worker:     "#ff9f45",  // offload / worker orange
    hover:      "#7cc0ff",  // cross-request qualname outline

    // Node bodies. The state lives in the stripe, so these barely move.
    nodeBody:       "#1e242d",
    nodeBodyDone:   "#171b22",
    nodeBorder:     "#414b5a",
    nodeBorderDone: "#2b323d",

    radius: 3,
    stripe: 4, // width of the left state stripe

    // Type. Every size up 1-2px from the old 9/10/11px set.
    fs: { node: 12, row: 12, tag: 11, zone: 12, meta: 10 },
  };

  VIZ.theme.mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  VIZ.theme.arrowHead = 7; // px, arrowhead length on a connector
})(window.VIZ);
