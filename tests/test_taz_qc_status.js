const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");

const statusStart = appSource.indexOf("function hasUserChanges");
const statusEnd = appSource.indexOf("function renderQueue", statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, "TAZ status functions should be present");
const statusFactory = new Function(
  "state",
  "CcFileLoader",
  "TAZ_STATUSES",
  `${appSource.slice(statusStart, statusEnd)}; return { hasUserChanges, importedCcDiffers, getTazStatus, markTazEdited };`
);
const state = {
  edits: {},
  importedCc: null,
  connectorCountsByTaz: new Map([["1", 2], ["2", 0]]),
  connectorsByTaz: new Map([["1", [{ nodeId: "10" }, { nodeId: "20" }]]]),
};
const cleanId = (value) => String(value).replace(/\.0+$/, "");
const { getTazStatus, markTazEdited } = statusFactory(state, { cleanId }, ["WAITING FOR QC", "FLAG", "EDITED", "REVIEWED"]);

assert.equal(getTazStatus("1"), "WAITING FOR QC", "default TAZ status should wait for QC");
assert.equal(getTazStatus("2"), "FLAG", "a TAZ with no connectors should be flagged");
state.importedCc = new Map([["1", [{ nodeId: "20" }, { nodeId: "10" }]]]);
assert.equal(getTazStatus("1"), "WAITING FOR QC", "same uploaded A/B pairs should remain waiting for QC");
state.importedCc = new Map([["1", [{ nodeId: "10" }, { nodeId: "30" }]]]);
assert.equal(getTazStatus("1"), "EDITED", "different uploaded CCs should become EDITED");
state.edits["1"] = { qcStatus: "REVIEWED" };
assert.equal(getTazStatus("1"), "REVIEWED", "manual REVIEWED should override the automatic status");
markTazEdited("1");
assert.equal(getTazStatus("1"), "EDITED", "a later edit should reopen a reviewed TAZ as EDITED");
state.edits["1"] = { qcStatus: "FLAG", note: "manual flag" };
assert.equal(getTazStatus("1"), "FLAG", "manual FLAG should be selectable from the context menu");
state.edits["2"] = { qcStatus: "REVIEWED" };
assert.equal(getTazStatus("2"), "FLAG", "zero-CC TAZs should remain flagged even after an explicit status change");

const shapeStart = appSource.indexOf("function makeDbf");
const shapeEnd = appSource.indexOf("function downloadBlob", shapeStart);
assert.ok(shapeStart >= 0 && shapeEnd > shapeStart, "Shapefile writer functions should be present");
const shapeFactory = new Function(
  `${appSource.slice(shapeStart, shapeEnd)}; return { makePolygonShapefile, makeTazStatusShapefile };`
);
const { makePolygonShapefile, makeTazStatusShapefile } = shapeFactory();
const data = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "core.json"), "utf8"));
const features = data.tazs.map((taz) => ({
  TAZ_ID: String(taz.id),
  QC_STATUS: "FLAG",
  QC_NOTES: taz.id === data.tazs[0].id ? "检查" : "",
  geom: taz.geom,
}));
const { shp, shx } = makePolygonShapefile(features);
assert.equal(new DataView(shp.buffer).getInt32(0, false), 9994);
assert.equal(new DataView(shp.buffer).getInt32(32, true), 5);
assert.equal(new DataView(shx.buffer).getInt32(0, false), 9994);
assert.equal((shx.length - 100) / 8, 658);

makeTazStatusShapefile(features).then(async (zipBlob) => {
  const zip = new Uint8Array(await zipBlob.arrayBuffer());
  assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x04034b50);
  const zipText = new TextDecoder().decode(zip);
  for (const extension of ["shp", "shx", "dbf", "prj", "cpg"]) {
    assert.match(zipText, new RegExp(`taz_qc_status\\.${extension}`));
  }
  console.log("TAZ QC status and Shapefile export tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
