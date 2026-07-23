const assert = require("node:assert/strict");
const loader = require("../docs/cc-file-loader.js");

const rows = loader.parseCsv(
  "A,B,LANES,HERE_MISS,FCLASS\r\n101,202,1,1,7\r\n202,101,1,1,7\r\n303,404,1,0,6\r\n"
);
const normalized = loader.normalizeMissingLinkRows(rows);
assert.equal(normalized.inputRows, 3);
assert.equal(normalized.linkCount, 1);
assert.equal(normalized.duplicates, 1);
assert.equal(normalized.ignored, 1);
assert.deepEqual(normalized.links, [{
  pairKey: "101|202",
  a: "101",
  b: "202",
  records: 2,
  lanes: 1,
  hereMiss: 1,
  fclass: 32,
}]);

(async () => {
  const loaded = await loader.loadMissingLinkFiles([{
    name: "HERE_MISS_links.csv",
    text: async () => "A,B,LANES,HERE_MISS,FCLASS\r\n900,1000,1,1,7\r\n1000,900,1,1,7\r\n",
  }]);
  assert.equal(loaded.linkCount, 1);
  assert.equal(loaded.duplicates, 1);
  assert.deepEqual(loaded.sourceNames, ["HERE_MISS_links.csv"]);
  await assert.rejects(
    () => loader.loadMissingLinkFiles([{ name: "links.txt", text: async () => "" }]),
    /Unsupported HERE_MISS file type/
  );
  console.log("HERE_MISS file loader tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
