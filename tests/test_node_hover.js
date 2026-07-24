const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
for (const relativePath of ["docs/app.js", "qaqc_web/static/app.js"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source, /hoveredNodeId:\s*null/, `${relativePath} should track the hovered candidate node`);
  assert.match(source, /function updateHoveredCandidateNode\(/, `${relativePath} should update candidate hover state`);
  if (relativePath === "docs/app.js") {
    assert.match(source, /function findEditableNodeAt\([^)]*hitRadius\s*=\s*18/, `${relativePath} should use an easy-to-hit hover target`);
    assert.match(source, /findEditableNodeAt\(pt,\s*18\)/, `${relativePath} should highlight red and eligible nodes during manual editing`);
  } else {
    assert.match(source, /function findEligibleNodeAt\([^)]*hitRadius\s*=\s*18/, `${relativePath} should keep the local eligible-node hover target`);
  }
  assert.match(source, /(?:hovered\s*\?\s*10|drawHighlightedCandidateNode\(p,\s*10\))/, `${relativePath} should enlarge a hovered candidate node`);
  assert.match(source, /#ff8500/, `${relativePath} should draw the orange candidate highlight`);
  assert.match(source, /activeRow\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/, `${relativePath} should preserve the list position when the current TAZ is already visible`);
}

console.log("Candidate node hover tests passed");
