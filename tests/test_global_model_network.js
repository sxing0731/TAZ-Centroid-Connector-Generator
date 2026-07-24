const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");
const generatorSource = fs.readFileSync(path.join(root, "generate_docs_data.py"), "utf8");

assert.match(generatorSource, /GSTDM_2025_NODE_0721\.shp/);
assert.match(generatorSource, /GSTDM_2025_LINK_0721\.shp/);
assert.match(generatorSource, /outside_ga_nodes = nonga_nodes - ga_nodes/);
assert.match(generatorSource, /"eligible": bool\(outside_ga or/);
assert.match(generatorSource, /pair_keys\.duplicated\(keep="first"\)/);
assert.match(generatorSource, /payload\["gstdmFeature"\] = feature/);
assert.match(generatorSource, /"outside_ga": bool\(node\.get\("outsideGa"\)\)/);

assert.match(appSource, /id: "major-nodes"[\s\S]{0,220}\["!=", \["get", "outside_ga"\], true\]/);
assert.match(appSource, /id: "non-major-nodes"[\s\S]{0,220}\["==", \["get", "outside_ga"\], true\]/);
assert.match(appSource, /id: "candidate-nodes-preview"/);
assert.match(appSource, /layers: \["candidate-nodes-preview", "major-nodes", "non-major-nodes"\]/);
assert.match(appSource, /outsideGa: properties\.outside_ga/);
assert.match(appSource, /if \(node\.outsideGa\) \{[\s\S]{0,100}node\.eligible = true/);
assert.match(htmlSource, /Eligible Nodes \(incl\. 35,147 outside GA\)/);
assert.match(htmlSource, /GSTDM Global Model Links/);
assert.match(htmlSource, /app\.js\?v=20260724-help-pdf-download/);

console.log("Global model network tests passed");
