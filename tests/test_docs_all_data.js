const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataRoot = path.join(root, "docs", "data");
const corePath = path.join(dataRoot, "core.json");
const manifestPath = path.join(dataRoot, "tiles", "manifest.json");
const overviewPath = path.join(dataRoot, "tiles", "overview.json");
const mvtManifestPath = path.join(dataRoot, "mvt", "manifest.json");
const nodeIndexPath = path.join(dataRoot, "tiles", "node-index.json");
const defaultCcPath = path.join(root, "input", "default", "cube_taz_cc_public.csv");
const defaultMissingPath = path.join(root, "input", "default", "HERE_MISS_links.csv");
const core = JSON.parse(fs.readFileSync(corePath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const overview = JSON.parse(fs.readFileSync(overviewPath, "utf8"));
const mvtManifest = JSON.parse(fs.readFileSync(mvtManifestPath, "utf8"));
const nodeIndex = JSON.parse(fs.readFileSync(nodeIndexPath, "utf8"));

assert.equal(core.schemaVersion, 5);
assert.equal(manifest.schemaVersion, 1);
assert.equal(core.count, core.tazOrder.length);
assert.equal(core.count, core.tazs.length);
assert.ok(core.connectors.length > 0);
assert.ok(core.connectorNodes.length > 0);
assert.ok(core.counts.nodes > 300000);
assert.ok(core.counts.gstdmLines > 0);
assert.equal(core.tileManifest, "data/tiles/manifest.json");
assert.equal(core.vectorTiles.format, "mvt");
assert.equal(core.vectorTiles.generalizationVersion, 3);
assert.ok(core.vectorTiles.layers.includes("candidate_nodes"));
assert.equal(core.vectorTiles.generalization.method, "topology-preserving-simplify");
assert.equal(core.vectorTiles.tiles, "data/mvt/{z}/{x}/{y}.pbf");
assert.equal(mvtManifest.maxzoom, 12);
assert.ok(mvtManifest.tileCount > 1000);
assert.ok(mvtManifest.bytes > 1_000_000);
assert.deepEqual(core.vectorTiles, mvtManifest);
assert.ok(manifest.tileSizeFeet > 0);
assert.ok(manifest.paddingFeet > 0);
assert.ok(manifest.detailScale > manifest.overviewScale);
assert.ok(Object.keys(manifest.tiles).length > 0);
assert.equal(fs.existsSync(path.join(dataRoot, "all.json")), false);
assert.equal(fs.existsSync(path.join(dataRoot, "taz")), false);
assert.equal(fs.existsSync(path.join(dataRoot, "index.json")), false);

const numericTazOrder = core.tazOrder.map((item) => Number(item.id));
assert.deepEqual(numericTazOrder, [...numericTazOrder].sort((left, right) => left - right));
const tazIds = new Set(core.tazs.map((item) => String(item.id)));
const centroidIds = new Set(core.centroids.map((item) => String(item.id)));
const connectorNodeIds = new Set(core.connectorNodes.map((item) => String(item.id)));
assert.ok(core.tazOrder.every((item) => tazIds.has(String(item.id))));
assert.ok(core.tazOrder.every((item) => centroidIds.has(String(item.id))));
assert.ok(core.connectors.every((item) => tazIds.has(String(item.tazId))));
assert.ok(core.connectors.every((item) => connectorNodeIds.has(String(item.nodeId))));
assert.ok(core.connectors.every((item) => typeof item.endBoundaryDist === "number"));
assert.ok(core.connectors.every((item) => typeof item.interiorFallback === "boolean"));
assert.ok(core.connectors.every((item) => item.interiorFallback === (item.endBoundaryDist > 200.000001)));
assert.ok(core.nodeSource);
assert.deepEqual(core.defaultInputs, {
  cc: "input/default/cube_taz_cc_public.csv",
  missingLinks: "input/default/HERE_MISS_links.csv",
  ccSourceDirectionalRecords: 29842,
  ccDirectionalRecords: 2934,
  ccPairs: 1467,
  ccSkippedOutsideCore: 26908,
  missingDirectionalRecords: 56,
  missingPairs: 28,
});

function simpleCsvRows(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").replace(/^\ufeff/, "").trim().split(/\r?\n/);
  const fields = lines.shift().split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])));
}

const expectedCcPairs = new Set();
for (const row of simpleCsvRows(defaultCcPath)) {
  if (tazIds.has(String(row.A))) expectedCcPairs.add(`${row.A}|${row.B}`);
  else if (tazIds.has(String(row.B))) expectedCcPairs.add(`${row.B}|${row.A}`);
}
const actualCcPairs = new Set(core.connectors.map((item) => `${item.tazId}|${item.nodeId}`));
assert.deepEqual([...actualCcPairs].sort(), [...expectedCcPairs].sort());

const pairKey = (a, b) => [String(a), String(b)]
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  .join("|");
const expectedMissingPairs = new Set(simpleCsvRows(defaultMissingPath).map((row) => pairKey(row.A, row.B)));
const actualMissingPairs = new Set(core.defaultMissingLinks.map((item) => item.pairKey));
assert.deepEqual([...actualMissingPairs].sort(), [...expectedMissingPairs].sort());
assert.equal(core.defaultMissingLinks.length, 28);
assert.ok(core.defaultMissingLinks.every((item) => nodeIndex[item.a] && nodeIndex[item.b]));
assert.ok(core.defaultMissingLinks.every((item) => item.aCoord.every(Number.isFinite) && item.bCoord.every(Number.isFinite)));
assert.ok(core.defaultMissingLinks.every((item) => item.records === 2));
assert.ok(core.defaultMissingLinks.every((item) => item.lanes === 1 && item.hereMiss === 1 && item.fclass === 32));
assert.ok(simpleCsvRows(defaultMissingPath).every((row) => row.FCLASS === "32"));

let tiledNodeCount = 0;
const tiledLineIds = new Set();
for (const [key, metadata] of Object.entries(manifest.tiles)) {
  if (metadata.nodes) {
    const tile = JSON.parse(fs.readFileSync(path.join(dataRoot, "tiles", "nodes", `${key}.json`), "utf8"));
    assert.equal(tile.nodes.length, metadata.nodes);
    tiledNodeCount += tile.nodes.length;
  }
  if (metadata.lines) {
    const tile = JSON.parse(fs.readFileSync(path.join(dataRoot, "tiles", "links", `${key}.json`), "utf8"));
    assert.equal(tile.lines.length, metadata.lines);
    for (const [lineId, coordinates] of tile.lines) {
      tiledLineIds.add(String(lineId));
      assert.ok(coordinates.length >= 2);
    }
  }
}
assert.equal(tiledNodeCount, core.counts.nodes);
assert.equal(tiledLineIds.size, core.counts.gstdmLines);
assert.equal(overview.coarseClusters.reduce((sum, item) => sum + item.count, 0), core.counts.nodes);
assert.equal(overview.mediumClusters.reduce((sum, item) => sum + item.count, 0), core.counts.nodes);
assert.ok(overview.gstdmLines.length < core.counts.gstdmLines);
assert.ok(
  fs.statSync(path.join(dataRoot, "tiles", "overview.json")).size < 5 * 1024 * 1024,
  "the global-network overview should remain below 5 MiB"
);

const connectorsByTaz = new Map();
for (const connector of core.connectors) {
  const tazId = String(connector.tazId);
  if (!connectorsByTaz.has(tazId)) connectorsByTaz.set(tazId, []);
  connectorsByTaz.get(tazId).push(connector);
}
let minimumAngle = 180;
for (const connectors of connectorsByTaz.values()) {
  assert.ok(connectors.length >= 1);
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
    }
  }
}
for (const item of core.tazOrder) {
  assert.equal(item.connectors, connectorsByTaz.get(String(item.id))?.length || 0);
}

const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const generatorSource = fs.readFileSync(path.join(root, "generate_docs_data.py"), "utf8");
assert.doesNotMatch(appSource, /data\/all\.json|data\/index\.json|item\.file|state\.cache/);
assert.match(appSource, /data\/core\.json/);
assert.match(appSource, /tileKeysForBounds/);
assert.match(appSource, /paddedViewportBounds/);
assert.match(appSource, /scheduleViewportLoad/);
assert.match(appSource, /finishCanvasPreview\(90\);[\s\S]*?scheduleViewportLoad\(\);/);
assert.match(appSource, /finishCanvasPreview\(\);[\s\S]*?scheduleViewportLoad\(\);/);
assert.match(appSource, /clearTimeout\(state\.viewportLoadTimer\)/);
assert.match(appSource, /fetchCached/);
assert.match(appSource, /viewportMode/);
assert.match(appSource, /drawNodeClusters/);
assert.match(appSource, /ensureImportedNodes/);
assert.match(appSource, /setViewToAllData/);
assert.match(appSource, /drawGlobalLinks/);
assert.match(appSource, /function visibleWorldBounds\(\)/);
assert.match(appSource, /layerOrder:/);
assert.match(appSource, /bindLayerReordering/);
assert.match(appSource, /QC_NOTES/);
assert.match(appSource, /cube_taz_cc_QCNOTES\.dbf/);
assert.match(appSource, /hoveredTazId/);
assert.match(appSource, /updateHoveredTaz/);
assert.match(appSource, /function exportFinalCc/);
assert.match(appSource, /function makeCsv/);
assert.match(appSource, /function resetBrowserData/);
assert.match(appSource, /state\.data\.defaultMissingLinks/);
assert.match(appSource, /missingLinksFromStorage/);
assert.match(appSource, /function getTazStatus/);
assert.match(appSource, /function exportTazQcStatus/);
assert.match(appSource, /function drawCentroidTriangle/);
assert.match(appSource, /function sortTazOrder/);
assert.match(appSource, /activeRow\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
assert.match(appSource, /generalizationVersion/);
assert.doesNotMatch(generatorSource, /OVERVIEW_QUANTIZE_FEET/);
assert.match(generatorSource, /OVERVIEW_SIMPLIFY_FEET_BY_ZOOM/);
assert.match(generatorSource, /simplify\(tolerance, preserve_topology=True\)/);

console.log(JSON.stringify({
  coreBytes: fs.statSync(corePath).size,
  tiles: Object.keys(manifest.tiles).length,
  nodes: tiledNodeCount,
  gstdmLines: tiledLineIds.size,
  overviewLines: overview.gstdmLines.length,
  minimumAngle,
}));
