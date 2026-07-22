const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
for (const relativePath of ["docs/app.js", "qaqc_web/static/app.js"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source, /touchPointers: new Map\(\)/, `${relativePath} should track both touches`);
  assert.match(source, /function beginPinchGesture\(\)/, `${relativePath} should initialize pinch gestures`);
  assert.match(source, /function updatePinchGesture\(\)/, `${relativePath} should update pinch gestures`);
  assert.match(source, /previous\.distance \/ current\.distance/, `${relativePath} should derive zoom from finger spacing`);
  assert.match(source, /current\.center\.x - previous\.center\.x/, `${relativePath} should follow the pinch center`);
  const pointerStart = source.indexOf('state.canvas.addEventListener("pointerdown"');
  const pointerEnd = source.indexOf('state.canvas.addEventListener("pointermove"', pointerStart);
  const pointerHandler = source.slice(pointerStart, pointerEnd);
  assert.ok(pointerStart >= 0 && pointerEnd > pointerStart, `${relativePath} should expose its pointer handler`);
  assert.ok(
    pointerHandler.indexOf("const node = findNodeAt(pt") < pointerHandler.indexOf("const connector = findConnectorAt(pt)"),
    `${relativePath} should prioritize a selected target node over a nearby connector line`
  );
  assert.match(pointerHandler, /event\.pointerType === "touch" \? 30/, `${relativePath} should provide a finger-sized node hit target`);
  assert.match(source, /function findNodeAt\([^)]*hitRadius/, `${relativePath} should accept the enlarged hit radius`);
}

for (const relativePath of ["docs/styles.css", "qaqc_web/static/styles.css"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source, /#mapCanvas[\s\S]*?touch-action:\s*none/, `${relativePath} should delegate touch gestures to the custom map handler`);
}

const docsSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
assert.match(docsSource, /function previewCanvasPan\(dx, dy\)/, "the static map should preview pan with a canvas transform");
assert.match(docsSource, /function previewCanvasZoom\(x, y, scale\)/, "the static map should preview zoom with a canvas transform");
assert.match(docsSource, /finishCanvasPreview\(90\)/, "the static map should debounce its detailed redraw until zooming stops");
assert.match(docsSource, /if \(state\.canvasPreviewActive\) return;/, "animation frames should not redraw detailed vectors during a preview transform");

console.log("Mobile pinch zoom tests passed");
