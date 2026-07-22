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
  console.log("QCNOTES DBF and CSV export tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
