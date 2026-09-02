// The row filter: `path:X status:N slow:true zone:loop|pool`, ANDed, with a
// bare word matching the path or the trace id.
//
// Display-only by design — it never hides events, only rows, so a filtered
// view can never mislead you about what the server actually reported.
//
// Pure: `parse` takes text, `matches` takes a branch plus the parsed terms and
// a slow-predicate. No canvas, no module state.
window.VIZ = window.VIZ || {};
(function (VIZ) {
  "use strict";

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

  function matchesTerm(b, t, isSlow) {
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

  VIZ.filter = {
    parse: parseFilter,
    matches: function (b, terms, isSlow) {
      for (var i = 0; i < terms.length; i++) {
        if (!matchesTerm(b, terms[i], isSlow)) return false;
      }
      return true;
    },
  };
})(window.VIZ);
