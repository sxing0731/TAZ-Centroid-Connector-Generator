const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const loader = require(path.resolve(__dirname, "..", "docs", "cc-file-loader.js"));

async function main() {
  const appSource = fs.readFileSync(path.resolve(__dirname, "..", "docs", "app.js"), "utf8");
  const start = appSource.indexOf("function makeDbf");
  const end = appSource.indexOf("function downloadBlob");
  assert.ok(start >= 0 && end > start, "DBF writer functions should be present");
  const factory = new Function(`${appSource.slice(start, end)}; return { makeDbf, makeCsv };`);
  const { makeDbf, makeCsv } = factory();
  const blob = makeDbf(
    [
      { A: "116", B: "66819", QC_NOTES: "Move connector away from ramp" },
      { A: "66819", B: "116", QC_NOTES: "Move connector away from ramp" },
    ],
    [
      { name: "A", len: 20 },
      { name: "B", len: 20 },
      { name: "QC_NOTES", len: 250 },
    ]
  );
  const parsed = loader.parseDbf(await blob.arrayBuffer());
  assert.deepEqual(parsed.map(({ A, B, QC_NOTES }) => ({ A, B, QC_NOTES })), [
    { A: "116", B: "66819", QC_NOTES: "Move connector away from ramp" },
    { A: "66819", B: "116", QC_NOTES: "Move connector away from ramp" },
  ]);
  const csvBlob = makeCsv(
    [{ A: "116", B: "66819", QC_NOTES: '检查, avoid "ramp"' }],
    ["A", "B", "QC_NOTES"]
  );
  const csvBytes = new Uint8Array(await csvBlob.arrayBuffer());
  assert.deepEqual(Array.from(csvBytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  const csv = await csvBlob.text();
  assert.match(csv, /^A,B,QC_NOTES\r\n/);
  assert.match(csv, /116,66819,"检查, avoid ""ramp"""/);
  const conflictStart = appSource.indexOf("function findCrossTazNodeConflicts");
  const conflictEnd = appSource.indexOf("async function exportFinalCc", conflictStart);
  assert.ok(conflictStart >= 0 && conflictEnd > conflictStart, "cross-TAZ export audit should be present");
  const conflictFactory = new Function(
    `${appSource.slice(conflictStart, conflictEnd)}; return findCrossTazNodeConflicts;`
  );
  const findConflicts = conflictFactory();
  assert.deepEqual(
    findConflicts([
      { A: "1", B: "77" },
      { A: "2", B: "77" },
      { A: "2", B: "88" },
      { A: "2", B: "88" },
    ]),
    [{ nodeId: "77", tazIds: ["1", "2"] }]
  );
  const angleStart = appSource.indexOf("function findTazAngleConflicts");
  const angleEnd = appSource.indexOf("async function exportFinalCc", angleStart);
  assert.ok(angleStart >= 0 && angleEnd > angleStart, "70-degree export audit should be present");
  const angleFactory = new Function(
    "angleDifference",
    "MIN_CC_ANGLE",
    `${appSource.slice(angleStart, angleEnd)}; return findTazAngleConflicts;`
  );
  const angleDifference = (first, second) => {
    const difference = Math.abs(first - second) % 360;
    return Math.min(difference, 360 - difference);
  };
  const findAngleConflicts = angleFactory(angleDifference, 70);
  assert.deepEqual(
    findAngleConflicts([
      { A: "1", B: "10", ANGLE_DEG: 0 },
      { A: "1", B: "20", ANGLE_DEG: 40 },
      { A: "2", B: "30", ANGLE_DEG: 0 },
      { A: "2", B: "40", ANGLE_DEG: 80 },
    ]),
    [{ tazId: "1", nodeIds: ["10", "20"], separation: 40 }]
  );
  const exportSource = appSource.slice(appSource.indexOf("async function exportFinalCc"), appSource.indexOf("function makeCsv"));
  assert.doesNotMatch(exportSource, /findTazAngleConflicts\(sourceRows\)/, "manual angle overrides should not block final export");
  assert.match(exportSource, /findCrossTazNodeConflicts\(sourceRows\)/, "cross-TAZ shared nodes should still block final export");
  console.log("QCNOTES DBF and CSV export tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
