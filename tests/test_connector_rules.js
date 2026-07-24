const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const start = appSource.indexOf("function pointSegmentDistance");
const end = appSource.indexOf("function selectConnector", start);
assert.ok(start >= 0 && end > start, "connector-rule geometry functions should be present");

const taz = {
  type: "Polygon",
  coordinates: [[[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]],
};
const state = {
  payload: { centroid: [500, 500], taz, connectors: [] },
  linkGrid: [],
  gstdmLines: [],
};
const factory = new Function(
  "state",
  "querySpatialGrid",
  "linkBoundsIntersect",
  "MIN_CC_ANGLE",
  `${appSource.slice(start, end)}; return { segmentOutsideLength, connectorCrossesGstdm, connectorTargetValidation, manualOverrideWarnings };`
);
const rules = factory(state, (grid) => grid, () => true, 70);

assert.ok(Math.abs(rules.segmentOutsideLength([500, 500], [1150, 500], taz) - 150) < 1e-6);
assert.ok(Math.abs(rules.segmentOutsideLength([500, 500], [1250, 500], taz) - 250) < 1e-6);
assert.equal(rules.connectorTargetValidation({ eligible: true, x: 1150, y: 500 }), "");
assert.equal(rules.connectorTargetValidation({ eligible: true, x: 1250, y: 500 }), "");
assert.equal(rules.connectorTargetValidation({ id: "66", eligible: false, majorLevel: 2, x: 900, y: 500 }), "");
assert.match(
  rules.manualOverrideWarnings({ id: "66", eligible: false, majorLevel: 2, x: 900, y: 500 }).join(" "),
  /red major node 66/
);
state.globalConnectors = [{ tazId: "2", nodeId: "77" }];
state.payload.tazId = "1";
assert.match(
  rules.connectorTargetValidation({ id: "77", eligible: true, x: 900, y: 500 }),
  /already used by TAZ 2/
);
state.globalConnectors = [];
state.payload.connectors = [{
  ccPt: "existing",
  geom: { type: "LineString", coordinates: [[500, 500], [900, 500]] },
}];
assert.equal(rules.connectorTargetValidation({ id: "88", eligible: true, x: 900, y: 600 }), "");
assert.equal(
  rules.connectorTargetValidation({ id: "88", eligible: true, x: 900, y: 600 }, "existing"),
  ""
);
state.payload.connectors = [];

state.linkGrid = [0];
state.gstdmLines = [[[800, 0], [800, 1000]]];
assert.equal(rules.connectorCrossesGstdm([500, 500], [900, 500]), true);
state.gstdmLines = [[[900, 500], [900, 1000]]];
assert.equal(rules.connectorCrossesGstdm([500, 500], [900, 500]), false);

console.log("Connector rule tests passed");
