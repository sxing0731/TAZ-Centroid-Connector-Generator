const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.resolve(__dirname, "..", "docs", "app.js"), "utf8");
const start = appSource.indexOf("function resetBrowserData()");
const end = appSource.indexOf("function shiftTaz", start);
assert.ok(start >= 0 && end > start, "resetBrowserData should be present");

const factory = new Function(
  "localStorage",
  "confirm",
  "window",
  "STORAGE_KEYS",
  `${appSource.slice(start, end)}; return resetBrowserData;`
);
const storageKeys = {
  edits: "tazQaqcEdits",
  importedCc: "tazQaqcImportedCc",
  layerOrder: "tazLayerOrder",
};

function makeStorage() {
  const values = new Map([
    [storageKeys.edits, "saved edits"],
    [storageKeys.importedCc, "uploaded CC"],
    [storageKeys.layerOrder, "layer order"],
    ["otherAppSetting", "keep me"],
  ]);
  return {
    values,
    removeItem(key) {
      values.delete(key);
    },
  };
}

{
  const localStorage = makeStorage();
  let reloads = 0;
  const reset = factory(localStorage, () => false, { location: { reload: () => reloads++ } }, storageKeys);
  reset();
  assert.equal(localStorage.values.size, 4);
  assert.equal(reloads, 0);
}

{
  const localStorage = makeStorage();
  let reloads = 0;
  const reset = factory(localStorage, () => true, { location: { reload: () => reloads++ } }, storageKeys);
  reset();
  assert.equal(localStorage.values.has(storageKeys.edits), false);
  assert.equal(localStorage.values.has(storageKeys.importedCc), false);
  assert.equal(localStorage.values.has(storageKeys.layerOrder), false);
  assert.equal(localStorage.values.get("otherAppSetting"), "keep me");
  assert.equal(reloads, 1);
}

console.log("Reset browser data tests passed");
