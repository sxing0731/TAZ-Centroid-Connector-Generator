const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "docs", "data", "all.json");
const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

assert.equal(data.schemaVersion, 2);
assert.equal(data.count, data.tazOrder.length);
assert.equal(data.count, data.tazs.length);
assert.ok(data.connectors.length > 0);
assert.ok(data.nodes.length > 300000);
assert.ok(data.links.length > 0);
assert.ok(data.tazOrder.every((item) => !("file" in item)));

const tazIds = new Set(data.tazs.map((item) => String(item.id)));
const centroidIds = new Set(data.centroids.map((item) => String(item.id)));
const nodeIds = new Set(data.nodes.map((item) => String(item.id)));
assert.ok(data.tazOrder.every((item) => tazIds.has(String(item.id))));
assert.ok(data.tazOrder.every((item) => centroidIds.has(String(item.id))));
assert.ok(data.connectors.every((item) => tazIds.has(String(item.tazId))));
assert.ok(data.connectors.every((item) => nodeIds.has(String(item.nodeId))));
assert.ok(data.nodeSource);

assert.equal(fs.existsSync(path.join(root, "docs", "data", "taz")), false);
assert.equal(fs.existsSync(path.join(root, "docs", "data", "index.json")), false);

const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
assert.doesNotMatch(appSource, /data\/index\.json|item\.file|state\.cache/);
assert.match(appSource, /data\/all\.json/);
assert.match(appSource, /setViewToAllData/);
assert.match(appSource, /drawGlobalLinks/);
assert.match(appSource, /function visibleWorldBounds\(\)/);
assert.match(appSource, /querySpatialGrid\(state\.nodeGrid, bounds\)/);
assert.match(appSource, /querySpatialGrid\(state\.connectorGrid, bounds\)/);
assert.match(appSource, /layerOrder:/);
assert.match(appSource, /bindLayerReordering/);
assert.match(appSource, /QC_NOTES/);
assert.match(appSource, /cube_taz_cc_QCNOTES\.dbf/);
assert.match(appSource, /hoveredTazId/);
assert.match(appSource, /updateHoveredTaz/);
assert.match(appSource, /function exportFinalCc/);
assert.match(appSource, /function makeCsv/);
assert.match(appSource, /function resetBrowserData/);
assert.match(appSource, /resetBrowserDataBtn/);
assert.match(appSource, /Object\.values\(STORAGE_KEYS\)/);
assert.match(appSource, /function getTazStatus/);
assert.match(appSource, /function exportTazQcStatus/);
assert.match(appSource, /function makePolygonShapefile/);

console.log(JSON.stringify({
  tazs: data.tazs.length,
  connectors: data.connectors.length,
  nodes: data.nodes.length,
  links: data.links.length,
  bytes: fs.statSync(dataPath).size,
}));
