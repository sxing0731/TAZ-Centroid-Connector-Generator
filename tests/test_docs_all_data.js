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
const numericTazOrder = data.tazOrder.map((item) => Number(item.id));
assert.deepEqual(numericTazOrder, [...numericTazOrder].sort((left, right) => left - right));

const tazIds = new Set(data.tazs.map((item) => String(item.id)));
const centroidIds = new Set(data.centroids.map((item) => String(item.id)));
const nodeIds = new Set(data.nodes.map((item) => String(item.id)));
assert.ok(data.tazOrder.every((item) => tazIds.has(String(item.id))));
assert.ok(data.tazOrder.every((item) => centroidIds.has(String(item.id))));
assert.ok(data.connectors.every((item) => tazIds.has(String(item.tazId))));
assert.ok(data.connectors.every((item) => nodeIds.has(String(item.nodeId))));
assert.ok(data.connectors.every((item) => typeof item.endBoundaryDist === "number"));
assert.ok(data.connectors.every((item) => typeof item.interiorFallback === "boolean"));
assert.ok(data.connectors.every((item) => item.interiorFallback === (item.endBoundaryDist > 200.000001)));
assert.ok(data.nodeSource);

const connectorsByTaz = new Map();
for (const connector of data.connectors) {
  const tazId = String(connector.tazId);
  if (!connectorsByTaz.has(tazId)) connectorsByTaz.set(tazId, []);
  connectorsByTaz.get(tazId).push(connector);
}
let minimumAngle = 180;
for (const connectors of connectorsByTaz.values()) {
  assert.ok(connectors.length >= 1 && connectors.length <= 3);
  const angles = connectors.map((connector) => {
    const coordinates = connector.geom.coordinates;
    const start = coordinates[0];
    const end = coordinates[coordinates.length - 1];
    return (Math.atan2(end[0] - start[0], end[1] - start[1]) * 180 / Math.PI + 360) % 360;
  });
  for (let first = 0; first < angles.length; first += 1) {
    for (let second = first + 1; second < angles.length; second += 1) {
      const raw = Math.abs(angles[first] - angles[second]) % 360;
      const separation = Math.min(raw, 360 - raw);
      minimumAngle = Math.min(minimumAngle, separation);
      assert.ok(separation >= 70 - 1e-9);
    }
  }
}

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
assert.match(appSource, /function drawCentroidTriangle/);
assert.match(appSource, /ctx\.fillStyle = "#e00000"/);
assert.match(appSource, /ctx\.strokeStyle = "rgba\(255,255,255,0\.98\)"/);
assert.match(appSource, /function sortTazOrder/);
assert.match(appSource, /renderQueue\(\{ revealCurrent: true \}\)/);
assert.match(appSource, /activeRow\.scrollIntoView\(\{ block: "center", inline: "nearest" \}\)/);

console.log(JSON.stringify({
  tazs: data.tazs.length,
  connectors: data.connectors.length,
  nodes: data.nodes.length,
  links: data.links.length,
  minimumAngle,
  bytes: fs.statSync(dataPath).size,
}));
