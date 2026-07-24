const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "global-review.json"), "utf8"));
const newData = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "core.json"), "utf8"));
const changed607Data = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "review-changed-607.json"), "utf8"));
const autoFixedSharedData = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "review-auto-fixed-shared.json"), "utf8"));
const chunks = data.globalReviewChunks.items.map((item) => (
  JSON.parse(fs.readFileSync(path.join(root, "docs", item.url.replace(/^data\//, "data/")), "utf8"))
));
const globalTazs = chunks.flatMap((item) => item.tazs);
const globalConnectors = chunks.flatMap((item) => item.connectors);

assert.equal(data.dataset, "GSTDM2025 Global TAZ and Global CC");
assert.equal(data.schemaVersion, 2);
assert.equal(data.counts.tazs, 6318);
assert.equal(data.counts.connectors, 14921);
assert.equal(data.counts.zeroConnectorTazs, 0);
assert.equal(data.simplifyFeet, 100);
assert.ok(
  fs.statSync(path.join(root, "docs", "data", "global-review.json")).size < 1024 * 1024,
  "preloaded Global review index should remain below 1 MiB"
);
assert.equal(data.tazOrder.length, data.counts.tazs);
assert.equal(data.centroids.length, data.counts.tazs);
assert.ok(data.globalReviewChunks.items.length > 3);
assert.ok(data.globalReviewChunks.items.every((item) => item.tazs <= 1000));
assert.ok(data.globalReviewChunks.items.every((item) => (
  fs.statSync(path.join(root, "docs", item.url.replace(/^data\//, "data/"))).size < 2.1 * 1024 * 1024
)));
assert.equal(globalTazs.length, data.counts.tazs);
assert.equal(globalConnectors.length, data.counts.connectors);
assert.equal(new Set(globalTazs.map((item) => item.id)).size, data.counts.tazs);
assert.equal(new Set(globalConnectors.map((item) => item.ccPt)).size, data.counts.connectors);
assert.ok(globalConnectors.every((item) => item.geom?.type === "LineString"));
const globalIds = new Set(data.tazOrder.map((item) => String(item.id)));
const newIds = new Set(newData.tazOrder.map((item) => String(item.id)));
assert.equal(newIds.size, 658);
assert.ok([...newIds].every((id) => globalIds.has(id)), "every New TAZ should exist in Global TAZ");
const changed607Ids = new Set(changed607Data.tazIds.map(String));
assert.equal(changed607Data.count, 607);
assert.equal(changed607Ids.size, 607);
assert.ok([...changed607Ids].every((id) => globalIds.has(id)), "every Changed 607 TAZ should exist in Global TAZ");
assert.ok([...changed607Ids].every((id) => !newIds.has(id)), "Changed 607 review list should exclude GSTDM2025_New_TAZ");
const autoFixedSharedIds = new Set(autoFixedSharedData.tazIds.map(String));
assert.equal(autoFixedSharedData.count, 606);
assert.equal(autoFixedSharedIds.size, 606);
assert.ok([...autoFixedSharedIds].every((id) => globalIds.has(id)), "every auto-fixed TAZ should exist in Global TAZ");

assert.match(appSource, /edits: "tazGlobalQaqcEdits_20260724_input1"/);
assert.match(appSource, /importedCc: "tazGlobalQaqcImportedCc_20260724_input1"/);
assert.match(appSource, /LEGACY_NEW_STORAGE_KEYS/);
assert.match(appSource, /fetchJson\("data\/global-review\.json"\)/);
assert.match(appSource, /fetchJson\("data\/review-changed-607\.json"\)/);
assert.match(appSource, /fetchJson\("data\/review-auto-fixed-shared\.json"\)/);
assert.match(appSource, /state\.changed607TazIds\.has\(String\(item\.id\)\)/);
assert.match(appSource, /state\.autoFixedSharedTazIds\.has\(String\(item\.id\)\)/);
assert.match(appSource, /function ensureGlobalReviewChunkForTaz\(tazId, refresh = true\)/);
assert.match(appSource, /await ensureGlobalReviewChunkForTaz\(id\)/);
assert.match(appSource, /async function ensureAllGlobalReviewChunks\(\)/);
assert.match(appSource, /function activeReviewTazOrder\(\)/);
assert.match(appSource, /async function activateGlobalReviewChunk\(chunkId, goToFirst = true\)/);
assert.match(appSource, /state\.data\.tazs = \[\]/);
assert.match(appSource, /const scopedOrder = activeReviewTazOrder\(\)/);
assert.match(appSource, /newTaz: false/);
assert.match(appSource, /newConnectors: false/);
assert.match(appSource, /hereMiss: true/);
assert.match(appSource, /state\.newTazIds\.has\(id\)\) return "REVIEWED"/);
assert.match(appSource, /await goToTaz\(targetId\)/);
assert.match(appSource, /markReviewed\(-1\)/);
assert.match(appSource, /markReviewed\(1\)/);
assert.match(htmlSource, /id="reviewedPrevBtn"[^>]*>Review \+ Previous</);
assert.match(htmlSource, /id="reviewedBtn"[^>]*>Review \+ Next</);
assert.match(appSource, /Nearest available: \$\{nearby\}/);
assert.match(appSource, /setAttribute\("aria-invalid", "true"\)/);

assert.match(htmlSource, /data-layer="newTaz"\s*\/>/);
assert.match(htmlSource, /data-layer="newConnectors"\s*\/>/);
assert.match(htmlSource, /data-layer="hereMiss" checked/);
assert.match(htmlSource, /Global TAZ Boundary \(6,318\)/);
assert.match(htmlSource, /Global CC \(14,921\)/);
assert.match(htmlSource, /rel="preload" href="data\/global-review\.json" as="fetch"/);
assert.match(htmlSource, /rel="preload" href="data\/review-changed-607\.json" as="fetch"/);
assert.match(htmlSource, /rel="preload" href="data\/review-auto-fixed-shared\.json" as="fetch"/);
assert.match(htmlSource, /value="changed-607">Changed 607</);
assert.match(htmlSource, /value="auto-fixed-shared">Auto-fixed Shared</);
assert.match(htmlSource, /id="tazStatusSummary"/);
assert.match(htmlSource, /id="dataBlockSelect"/);
assert.match(htmlSource, /id="statusReviewedCount"/);
assert.match(htmlSource, /id="statusWaitingCount"/);
assert.match(appSource, /function updateTazStatusSummary\(\)/);
assert.match(appSource, /updateTazStatusSummary\(\);/);

console.log("Global TAZ and Global CC review tests passed");
