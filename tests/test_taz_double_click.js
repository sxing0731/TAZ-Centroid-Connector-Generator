const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");

const bindStart = appSource.indexOf("function bindCanvas");
const bindEnd = appSource.indexOf("function updateHoveredCandidateNode", bindStart);
const bindCanvas = appSource.slice(bindStart, bindEnd);
const doubleClickStart = bindCanvas.indexOf('addEventListener("dblclick"');
const pointerDownStart = bindCanvas.indexOf('addEventListener("pointerdown"');
const doubleClickBlock = bindCanvas.slice(doubleClickStart, pointerDownStart);

assert.ok(doubleClickStart >= 0, "the map should bind a double-click action");
assert.match(doubleClickBlock, /findTazLabelAt\(pt\)/, "double-clicking a TAZ number should take priority");
assert.match(doubleClickBlock, /findConnectorAt\(pt\)/, "double-clicking a CC should not switch TAZs");
assert.match(doubleClickBlock, /findTazAt\(pt\)/, "double-click should hit-test the TAZ polygon");
assert.match(doubleClickBlock, /goToTaz\(taz\.id\)/, "double-click should select the hit TAZ");

const finishStart = appSource.indexOf("function finishPointer");
const finishEnd = appSource.indexOf("function eventPoint", finishStart);
const finishPointer = appSource.slice(finishStart, finishEnd);
assert.doesNotMatch(finishPointer, /goToTaz|findTazAt/, "single pointer-up should no longer select a TAZ");

assert.match(appSource, /function findTazLabelAt\(pt, radius = 22\)/);

assert.match(htmlSource, /Double-click TAZ: select/);
assert.match(htmlSource, /double-click any TAZ polygon or number/);

console.log("TAZ double-click selection tests passed");
