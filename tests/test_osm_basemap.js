const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "docs/app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "docs/index.html"), "utf8");

assert.doesNotMatch(appSource, /Leaflet|leaflet|\bL\./);
assert.doesNotMatch(htmlSource, /leaflet@|id="leafletMap"/);
assert.match(htmlSource, /maplibre-gl@5\.16\.0\/dist\/maplibre-gl\.css/);
assert.match(htmlSource, /maplibre-gl@5\.16\.0\/dist\/maplibre-gl\.js/);
assert.match(htmlSource, /id="maplibreMap"/);
assert.match(htmlSource, />OpenStreetMap<\/option>/);
assert.match(htmlSource, />Satellite<\/option>/);
assert.match(htmlSource, /id="basemapAttribution"/);
assert.match(htmlSource, /id="otherTazVisibility"/);
assert.match(htmlSource, /id="otherTazVisibilityValue"/);

assert.match(appSource, /new maplibregl\.Map\(/);
assert.match(appSource, /type: "vector"/);
assert.match(appSource, /new URL\("data\/mvt\/", document\.baseURI\)/);
assert.match(appSource, /tiles: \[vectorTileUrl\]/);
assert.match(appSource, /"source-layer": "gstdm"/);
assert.match(appSource, /"source-layer": "nodes"/);
assert.match(appSource, /"connectors-live"/);
assert.match(appSource, /id: "current-taz-connectors"/);
assert.match(appSource, /id: "current-connector-labels"/);
assert.match(appSource, /id: "current-centroid-marker"/);
assert.match(appSource, /id: "node-clusters"[\s\S]{0,160}minzoom: 10, maxzoom: 12/);
assert.match(appSource, /id: "node-cluster-count"/);
assert.match(appSource, /"text-field": \["to-string", \["get", "count"\]\]/);
assert.match(appSource, /"fill-opacity": 0\.38/);
assert.match(appSource, /function formatConnectorLabel\(ccPt, tazId\)/);
assert.match(appSource, /display_label: formatConnectorLabel\(connector\.ccPt, connector\.tazId\)/);
assert.match(appSource, /"text-field": \["get", "display_label"\]/);
assert.match(appSource, /\["connector-labels", "current-connector-labels"\]/);
assert.match(appSource, /function applyOtherTazVisibility\(\)/);
assert.match(appSource, /STORAGE_KEYS\.otherTazVisibility/);
assert.match(appSource, /state\.maplibreMap\.setFilter\(layer, \["!=", \["get", "taz_id"\], tazId\]\)/);
assert.match(appSource, /queryRenderedFeatures/);
assert.doesNotMatch(appSource, /function drawBasemap\(|basemapTileCache/);

const labelHelpers = appSource.match(/function integerTazId[\s\S]*?\r?\n}\r?\n\r?\nfunction formatConnectorLabel[\s\S]*?\r?\n}/)?.[0];
assert.ok(labelHelpers, "connector label helpers should be present");
const labelContext = {};
vm.runInNewContext(`${labelHelpers}; result = formatConnectorLabel("4.0_S2", "4.0");`, labelContext);
assert.equal(labelContext.result, "TAZ 4 - S2");

console.log("MapLibre MVT basemap tests passed");
