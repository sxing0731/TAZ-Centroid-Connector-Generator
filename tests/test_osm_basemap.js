const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
for (const relativePath of ["docs/app.js", "qaqc_web/static/app.js"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source, /https:\/\/tile\.openstreetmap\.org\/\$\{z\}\/\$\{x\}\/\$\{y\}\.png/);
  assert.match(source, /function scheduleTileRedraw\(\)/);
  assert.match(source, /state\.tileCache\.size > 256/);
  assert.doesNotMatch(source, /World_Street_Map/);
}

for (const relativePath of ["docs/index.html", "qaqc_web/static/index.html"]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source, />OpenStreetMap<\/option>/);
  assert.match(source, /id="basemapAttribution"/);
}

console.log("OpenStreetMap basemap tests passed");
