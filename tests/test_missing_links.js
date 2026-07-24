const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");
const styleSource = fs.readFileSync(path.join(root, "docs", "styles.css"), "utf8");
const helpDocumentPath = path.join(root, "docs", "TAZ_CC_Rules_and_HERE_MISS_Workflow.pdf");

assert.match(htmlSource, /id="addMissingLinkBtn"/, "top toolbar should expose Add Missing Links");
assert.match(htmlSource, /id="loadMissingLinksBtn"/, "top toolbar should expose HERE_MISS file loading");
assert.match(htmlSource, /id="hereMissingFileInput"[^>]+accept="\.dbf,\.csv,\.cvs"/, "HERE_MISS loading should accept exported DBF and CSV files");
assert.match(htmlSource, /id="exportMissingLinksBtn"/, "top toolbar should expose HERE_MISS export");
assert.match(htmlSource, /data-layer="hereMiss"/, "HERE_MISS should have an independent layer toggle");
assert.match(htmlSource, /id="missingLinkContextMenu"/, "HERE_MISS should expose a delete context menu");
assert.match(htmlSource, /data-inspector-tab="cc"/, "right panel should include a CC table tab");
assert.match(htmlSource, /data-inspector-tab="missing"/, "right panel should include a missing-link table tab");
assert.match(htmlSource, /data-inspector-tab="taz"/, "right panel should include a TAZ-status table tab");
assert.match(htmlSource, /id="inspectorResizer"/, "right table panel should have a resize handle");
assert.match(htmlSource, /class="toolbar-edit-expanded"/, "edit actions should remain expanded in the top toolbar");
assert.match(htmlSource, /<summary>INPUT<\/summary>/, "file loading should be grouped under INPUT");
assert.match(htmlSource, /<summary>OUTPUT<\/summary>/, "exports should be grouped under OUTPUT");
assert.match(htmlSource, /id="helpPdfLink"[\s\S]*?class="toolbar-direct-help"[\s\S]*?href="TAZ_CC_Rules_and_HERE_MISS_Workflow\.pdf"[\s\S]*?download="TAZ_CC_Rules_and_HERE_MISS_Workflow\.pdf"[\s\S]*?>Help PDF<\/a>/, "Help PDF should be a direct PDF download link");
assert.doesNotMatch(htmlSource, /<summary>Help<\/summary>/, "Help should not be a dropdown");
assert.doesNotMatch(htmlSource, /showInstructions|instructionsBtn/, "Help PDF must not retain the legacy popup listener");
assert.doesNotMatch(appSource, /downloadHelpDocument|instructionsBtn|hideInstructions/, "Help PDF must not rely on legacy instruction-panel JavaScript");
assert.ok(fs.existsSync(helpDocumentPath), "the Help PDF should be published with the static web app");
assert.match(styleSource, /@media \(max-width: 720px\)[\s\S]*?\.topbar \{[\s\S]*?grid-template-columns: 1fr;/, "small screens should stack the brand and grouped action menus");
assert.match(styleSource, /\.toolbar-menu-panel \{[\s\S]*?position: fixed;/, "small-screen dropdown panels should fit the viewport");
assert.match(appSource, /"here-miss-live": \{ type: "geojson"/, "HERE_MISS should use its own GeoJSON source");
assert.match(appSource, /function chooseMissingLinkNode\(node\)/, "node-pair editing should be implemented");
assert.match(appSource, /function importMissingLinkFiles\(event\)/, "HERE_MISS DBF\/CSV import should be implemented");
assert.match(appSource, /loadMissingLinkFiles\(files\)/, "HERE_MISS import should use the shared file parser");
assert.match(appSource, /state\.missingLinks = validMissingLinks\(state\.data\.defaultMissingLinks\)/, "published HERE_MISS records should be the initial default");
assert.match(appSource, /function findMissingLinkAt\(pt\)/, "HERE_MISS lines should be selectable on the map");
assert.match(appSource, /function deleteSelectedMissingLink\(\)/, "selected HERE_MISS links should be deletable");
assert.match(appSource, /function zoomToMissingLink\(link\)/, "missing-link table rows should support zooming to their link");
assert.match(appSource, /row\.addEventListener\("dblclick", \(event\) => \{[\s\S]*?zoomToMissingLink\(link\)/, "double-clicking a missing-link row should zoom to that link");
assert.match(appSource, /row\.classList\.toggle\("selected-row", String\(link\.pairKey\) === selectedMissing\)/, "selected HERE_MISS table rows should be highlighted");
assert.match(appSource, /row\.classList\.toggle\("selected-row", String\(connector\.ccPt\) === selectedCc\)/, "selected CC table rows should be highlighted");
assert.match(appSource, /clearSelectionOnPointerUp/, "clicking blank map space should clear link selection");
assert.match(appSource, /function appendEditableTableCell/, "table attributes should expose inline editors");
assert.match(appSource, /function editConnectorTableField/, "CC table edits should update connector data");
assert.match(appSource, /function editMissingLinkTableField/, "missing-link table edits should update link data");
assert.match(appSource, /function editTazNote/, "TAZ table notes should be editable");
assert.match(appSource, /hereMiss: 1,\s+fclass: 32,/, "missing-link defaults should be HERE_MISS=1 and FCLASS=32");
assert.doesNotMatch(appSource, /fclass:\s*7/, "map features must not publish the old FCLASS=7 value");

const defaults = { lanes: 1, hereMiss: 1, fclass: 32 };
const mapStart = appSource.indexOf("function missingLinkGeoJson");
const mapEnd = appSource.indexOf("function centroidTriangleImage", mapStart);
assert.ok(mapStart >= 0 && mapEnd > mapStart, "missing-link map helper should be extractable");
const mapFactory = new Function(
  "state",
  "projectedGeometryToLonLat",
  "MISSING_LINK_DEFAULTS",
  `${appSource.slice(mapStart, mapEnd)}; return missingLinkGeoJson();`
);
const mapped = mapFactory(
  { missingLinks: [{ a: "101", b: "202", aCoord: [1, 2], bCoord: [3, 4], pairKey: "101|202" }] },
  (geometry) => geometry,
  defaults
);
assert.deepStrictEqual(mapped.features[0].properties, {
  pair_key: "101|202",
  a: "101",
  b: "202",
  lanes: 1,
  here_miss: 1,
  fclass: 32,
});

const exportStart = appSource.indexOf("function missingLinkExportRows");
const exportEnd = appSource.indexOf("function tazQcStatusRows", exportStart);
assert.ok(exportStart >= 0 && exportEnd > exportStart, "missing-link export helper should be extractable");
const exportFactory = new Function(
  "state",
  "MISSING_LINK_DEFAULTS",
  `${appSource.slice(exportStart, exportEnd)}; return missingLinkExportRows();`
);
const rows = exportFactory({
  missingLinks: [{ a: "101", b: "202", aCoord: [1, 2], bCoord: [3, 4], pairKey: "101|202" }],
}, defaults);
assert.deepStrictEqual(rows, [
  { A: "101", B: "202", LANES: 1, HERE_MISS: 1, FCLASS: 32 },
  { A: "202", B: "101", LANES: 1, HERE_MISS: 1, FCLASS: 32 },
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
  assert.match(csv, /101,202,1,1,32\r\n202,101,1,1,32/);
  console.log("missing-link editor/export checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
