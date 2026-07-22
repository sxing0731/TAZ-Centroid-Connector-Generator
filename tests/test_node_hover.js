const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
for (const relativePath of ["docs/app.js", "qaqc_web/static/app.js"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source, /hoveredNodeId:\s*null/, `${relativePath} should track the hovered candidate node`);
  assert.match(source, /function updateHoveredCandidateNode\(/, `${relativePath} should update candidate hover state`);
  assert.match(source, /function findEligibleNodeAt\([^)]*hitRadius\s*=\s*18/, `${relativePath} should use an easy-to-hit hover target`);
  assert.match(source, /selected(?:Connector)?[\s\S]{0,180}eligible[\s\S]{0,180}hoveredNodeId/, `${relativePath} should highlight only eligible nodes while a connector is selected`);
  assert.match(source, /(?:hovered\s*\?\s*10|drawHighlightedCandidateNode\(p,\s*10\))/, `${relativePath} should enlarge a hovered candidate node`);
  assert.match(source, /#ff8500/, `${relativePath} should draw the orange candidate highlight`);
  assert.match(source, /activeRow\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/, `${relativePath} should preserve the list position when the current TAZ is already visible`);
}

console.log("Candidate node hover tests passed");
