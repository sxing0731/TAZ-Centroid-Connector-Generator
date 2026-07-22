const assert = require("node:assert/strict");
const loader = require("../docs/cc-file-loader.js");

function sampleDbf(rows) {
  const fields = [
    { name: "A", length: 12 },
    { name: "B", length: 12 },
    { name: "FCLASS", length: 5 },
  ];
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0);
  const buffer = new ArrayBuffer(headerLength + rows.length * recordLength + 1);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes[0] = 0x03;
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  fields.forEach((field, index) => {
    const offset = 32 + index * 32;
    for (let i = 0; i < field.name.length; i += 1) bytes[offset + i] = field.name.charCodeAt(i);
    bytes[offset + 11] = "C".charCodeAt(0);
    bytes[offset + 16] = field.length;
  });
  bytes[headerLength - 1] = 0x0d;
  rows.forEach((row, rowIndex) => {
    let offset = headerLength + rowIndex * recordLength;
    bytes[offset++] = 0x20;
    for (const field of fields) {
      const text = String(row[field.name] ?? "").padEnd(field.length, " ").slice(0, field.length);
      for (let i = 0; i < field.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
      offset += field.length;
    }
  });
  return buffer;
}

const parsed = loader.parseDbf(sampleDbf([
  { A: "1008", B: "239867", FCLASS: "32" },
  { A: "239867", B: "1008", FCLASS: "32" },
]));
assert.equal(parsed.length, 2);
assert.equal(parsed[0].A, "1008");

const normalized = loader.normalizeRows(parsed, ["1008"]);
assert.equal(normalized.connectorCount, 1);
assert.equal(normalized.duplicates, 1);
assert.equal(normalized.byTaz["1008"][0].nodeId, "239867");

const csv = loader.parseCsv('TAZ_ID,CC_NODE,NOTE\r\n1008,437240,"comma, quote"\r\n');
assert.equal(csv[0].NOTE, "comma, quote");
assert.equal(loader.normalizeRows(csv, ["1008"]).connectorCount, 1);

const geojsonRows = loader.rowsFromJson({
  type: "FeatureCollection",
  features: [{ properties: { TAZ_ID: "1008", CC_NODE: "239632" }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }],
});
assert.equal(loader.normalizeRows(geojsonRows, ["1008"]).connectorCount, 1);

console.log("CC file loader tests passed");

if (process.argv[2] && process.argv[3]) {
  const fs = require("node:fs");
  const dbfBytes = fs.readFileSync(process.argv[2]);
  const index = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const actualRows = loader.parseDbf(dbfBytes.buffer.slice(dbfBytes.byteOffset, dbfBytes.byteOffset + dbfBytes.byteLength));
  const actual = loader.normalizeRows(actualRows, index.tazOrder.map((item) => item.id));
  assert.ok(actual.connectorCount > 0, "actual DBF should contain recognized CC records");
  console.log(JSON.stringify({
    inputRows: actual.inputRows,
    connectorCount: actual.connectorCount,
    duplicates: actual.duplicates,
    ignored: actual.ignored,
    tazWithCc: Object.keys(actual.byTaz).length,
  }));
}
