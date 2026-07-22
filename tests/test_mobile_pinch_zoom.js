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
}

for (const relativePath of ["docs/styles.css", "qaqc_web/static/styles.css"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source, /#mapCanvas[\s\S]*?touch-action:\s*none/, `${relativePath} should delegate touch gestures to the custom map handler`);
}

console.log("Mobile pinch zoom tests passed");
