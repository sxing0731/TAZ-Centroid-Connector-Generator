const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const publicApp = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const localServer = fs.readFileSync(path.join(root, "qaqc_web.py"), "utf8");
const localApp = fs.readFileSync(path.join(root, "qaqc_web", "static", "app.js"), "utf8");

const publicValidation = publicApp.slice(
  publicApp.indexOf("function connectorTargetValidation"),
  publicApp.indexOf("function manualOverrideWarnings")
);
assert.match(publicValidation, /!node\?\.eligible/, "red major nodes must remain locked");
assert.match(publicValidation, /crossTazNodeOwner/, "cross-TAZ node sharing must remain locked");
assert.doesNotMatch(publicValidation, /angleConflict|outsideLength|connectorCrossesGstdm/, "manual geometry rules should not block browser edits");
assert.doesNotMatch(publicApp, /Each TAZ can have at most 3 connectors|Each TAZ must keep at least 1 connector/, "manual CC count changes should be allowed");

const localValidation = localServer.slice(
  localServer.indexOf("    def _validate_target"),
  localServer.indexOf("    def save_edit", localServer.indexOf("    def _validate_target"))
);
assert.match(localValidation, /SNAP_ELIG/, "local server must keep major nodes locked");
assert.match(localValidation, /already used by TAZ/, "local server must keep cross-TAZ node sharing locked");
assert.doesNotMatch(localValidation, /raise ValueError\([^)]*(?:degrees|outside|cross a GSTDM)/s, "local server should record, not reject, manual geometry overrides");
assert.doesNotMatch(localServer, /already has the maximum|must keep at least/, "local server should allow manual CC count changes");
assert.match(localServer, /"CROSSES_GSTDM"\] = crosses_gstdm/, "manual GSTDM crossings should remain truthfully recorded");
assert.match(localApp, /async function saveConnectorToNode[\s\S]*?catch \(error\) \{\s*toast\(error\.message\)/, "local save errors should appear in the warning banner");
assert.match(localApp, /async function addConnectorToNode[\s\S]*?catch \(error\) \{\s*toast\(error\.message\)/, "local add errors should appear in the warning banner");

for (const relativePath of ["docs/styles.css", "qaqc_web/static/styles.css"]) {
  const css = fs.readFileSync(path.join(root, relativePath), "utf8");
  const toast = css.slice(css.indexOf(".toast {"), css.indexOf("}", css.indexOf(".toast {") + 1));
  assert.match(css, /\.toast\s*\{[\s\S]*?top:\s*14px/, `${relativePath} should place warnings at the top of the map`);
  assert.match(css, /\.toast\s*\{[\s\S]*?font-size:\s*16px/, `${relativePath} should use larger warning text`);
}

console.log("Manual override and warning position tests passed");
