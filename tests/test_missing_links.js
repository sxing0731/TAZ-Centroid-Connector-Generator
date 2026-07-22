const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");

assert.match(htmlSource, /id="addMissingLinkBtn"/, "top toolbar should expose Add Missing Links");
assert.match(htmlSource, /id="exportMissingLinksBtn"/, "top toolbar should expose HERE_MISS export");
assert.match(htmlSource, /data-layer="hereMiss"/, "HERE_MISS should have an independent layer toggle");
assert.match(htmlSource, /id="missingLinkContextMenu"/, "HERE_MISS should expose a delete context menu");
assert.match(htmlSource, /data-inspector-tab="cc"/, "right panel should include a CC table tab");
assert.match(htmlSource, /data-inspector-tab="missing"/, "right panel should include a missing-link table tab");
assert.match(htmlSource, /data-inspector-tab="taz"/, "right panel should include a TAZ-status table tab");
assert.match(htmlSource, /id="inspectorResizer"/, "right table panel should have a resize handle");
assert.match(appSource, /"here-miss-live": \{ type: "geojson"/, "HERE_MISS should use its own GeoJSON source");
assert.match(appSource, /function chooseMissingLinkNode\(node\)/, "node-pair editing should be implemented");
assert.match(appSource, /function findMissingLinkAt\(pt\)/, "HERE_MISS lines should be selectable on the map");
assert.match(appSource, /function deleteSelectedMissingLink\(\)/, "selected HERE_MISS links should be deletable");
assert.match(appSource, /function zoomToMissingLink\(link\)/, "missing-link table rows should support zooming to their link");
assert.match(appSource, /row\.addEventListener\("dblclick", \(event\) => \{[\s\S]*?zoomToMissingLink\(link\)/, "double-clicking a missing-link row should zoom to that link");
assert.match(appSource, /row\.classList\.toggle\("selected-row", String\(link\.pairKey\) === selectedMissing\)/, "selected HERE_MISS table rows should be highlighted");
assert.match(appSource, /row\.classList\.toggle\("selected-row", String\(connector\.ccPt\) === selectedCc\)/, "selected CC table rows should be highlighted");

const exportStart = appSource.indexOf("function missingLinkExportRows");
const exportEnd = appSource.indexOf("function tazQcStatusRows", exportStart);
assert.ok(exportStart >= 0 && exportEnd > exportStart, "missing-link export helper should be extractable");
const exportFactory = new Function(
  "state",
  `${appSource.slice(exportStart, exportEnd)}; return missingLinkExportRows();`
);
const rows = exportFactory({
  missingLinks: [{ a: "101", b: "202", aCoord: [1, 2], bCoord: [3, 4], pairKey: "101|202" }],
});
assert.deepStrictEqual(rows, [
  { A: "101", B: "202", LANES: 1, HERE_MISS: 1, FCLASS: 7 },
  { A: "202", B: "101", LANES: 1, HERE_MISS: 1, FCLASS: 7 },
]);

const dbfStart = appSource.indexOf("function makeDbf");
const dbfEnd = appSource.indexOf("function ringArea", dbfStart);
const dbfFactory = new Function(`${appSource.slice(dbfStart, dbfEnd)}; return { makeDbf, makeCsv };`);
const { makeDbf, makeCsv } = dbfFactory();
const fields = [
  { name: "A", len: 20 },
  { name: "B", len: 20 },
  { name: "LANES", type: "N", len: 5 },
  { name: "HERE_MISS", type: "N", len: 5 },
  { name: "FCLASS", type: "N", len: 5 },
];

(async () => {
  const dbf = new Uint8Array(await makeDbf(rows, fields).arrayBuffer());
  const view = new DataView(dbf.buffer);
  assert.strictEqual(view.getUint32(4, true), 2, "DBF should contain two directional records");
  const fieldNames = fields.map((_, index) => {
    const bytes = dbf.slice(32 + index * 32, 32 + index * 32 + 11);
    return Buffer.from(bytes).toString("latin1").replace(/\0.*$/, "");
  });
  assert.deepStrictEqual(fieldNames, ["A", "B", "LANES", "HERE_MISS", "FCLASS"]);
  assert.deepStrictEqual(fields.map((_, index) => String.fromCharCode(dbf[32 + index * 32 + 11])), ["C", "C", "N", "N", "N"]);

  const csv = await makeCsv(rows, fieldNames).text();
  assert.match(csv, /^A,B,LANES,HERE_MISS,FCLASS\r\n/);
  assert.match(csv, /101,202,1,1,7\r\n202,101,1,1,7/);
  console.log("missing-link editor/export checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
