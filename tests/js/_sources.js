// The frontend's load order, in one place.
//
// The harnesses evaluate these in sequence into a single sandbox, exactly as
// the browser does via the <script> tags in index.html — so a file that gets
// added, renamed or reordered without index.html agreeing shows up here as a
// test failure rather than as a blank dashboard.
const fs = require("fs");
const path = require("path");

const STATIC = path.join(__dirname, "..", "..", "src", "fastapi_visualizer", "static");

const ORDER = [
  "viz/theme.js",
  "viz/geometry.js",
  "viz/primitives.js",
  "viz/filter.js",
  "dashboard.js",
];

function loadAll(vm, sandbox) {
  ORDER.forEach(function (rel) {
    const file = path.join(STATIC, rel);
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  });
}

module.exports = { STATIC, ORDER, loadAll };
