const STORAGE_KEYS = Object.freeze({
  edits: "tazGlobalQaqcEdits_20260724_input1",
  importedCc: "tazGlobalQaqcImportedCc_20260724_input1",
  missingLinks: "tazQaqcMissingLinks_20260724_input1",
  inspectorWidth: "tazQaqcInspectorWidth",
  layerOrder: "tazGlobalLayerOrder",
  otherTazVisibility: "tazGlobalOtherTazVisibility",
});
const LEGACY_NEW_STORAGE_KEYS = Object.freeze({
  edits: "tazQaqcEdits",
  importedCc: "tazQaqcImportedCc",
});
const TAZ_STATUSES = Object.freeze(["WAITING FOR QC", "FLAG", "EDITED", "REVIEWED"]);
const MISSING_LINK_DEFAULTS = Object.freeze({
  lanes: 1,
  hereMiss: 1,
  fclass: 32,
});

function readStoredJson(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved == null ? fallback : JSON.parse(saved);
  } catch (error) {
    console.warn(`Could not read browser-saved data for ${key}`, error);
    localStorage.removeItem(key);
    return fallback;
  }
}

const storedOtherTazVisibility = Number(readStoredJson(STORAGE_KEYS.otherTazVisibility, 55));
const storedMissingLinks = readStoredJson(STORAGE_KEYS.missingLinks, null);

function validMissingLinks(value) {
  return Array.isArray(value)
    ? value.filter((link) => link && link.a != null && link.b != null
      && Array.isArray(link.aCoord) && link.aCoord.length >= 2
      && Array.isArray(link.bCoord) && link.bCoord.length >= 2
      && link.aCoord.every(Number.isFinite) && link.bCoord.every(Number.isFinite))
      .map((link) => ({
        ...link,
        records: Math.max(1, Math.min(2, Number(link.records) || 2)),
        lanes: Number.isFinite(Number(link.lanes)) ? Number(link.lanes) : MISSING_LINK_DEFAULTS.lanes,
        hereMiss: Number.isFinite(Number(link.hereMiss)) ? Number(link.hereMiss) : MISSING_LINK_DEFAULTS.hereMiss,
        fclass: Number.isFinite(Number(link.fclass)) ? Number(link.fclass) : MISSING_LINK_DEFAULTS.fclass,
      }))
    : [];
}

const state = {
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  data: null,
  newData: null,
  index: null,
  tileManifest: null,
  viewportCache: new Map(),
  overviewData: null,
  nodeIndex: null,
  connectorNodes: [],
  viewportNodes: [],
  pinnedNodes: new Map(),
  activeClusters: [],
  viewportMode: "detail",
  activeTileKeys: [],
  viewportLoadTimer: null,
  viewportRequestId: 0,
  viewportLoading: false,
  tazOrder: [],
  currentIndex: 0,
  payload: null,
  tazById: new Map(),
  centroidById: new Map(),
  connectorsByTaz: new Map(),
  newConnectorsByTaz: new Map(),
  newTazIds: new Set(),
  nodeById: new Map(),
  nodeGrid: new Map(),
  linkGrid: new Map(),
  gstdmLines: [],
  gstdmLineBounds: null,
  gstdmCacheCanvas: null,
  gstdmCacheKey: "",
  connectorGrid: new Map(),
  globalConnectors: [],
  newConnectors: [],
  connectorCountsByTaz: new Map(),
  globalReviewChunks: null,
  globalReviewChunkByTaz: new Map(),
  globalReviewChunkUrls: new Map(),
  globalReviewChunkPromises: new Map(),
  loadedGlobalReviewChunks: new Set(),
  activeGlobalReviewChunk: null,
  dataIndexesReady: false,
  selected: null,
  selectedMissingLink: null,
  pendingNode: null,
  dirty: false,
  addMode: false,
  missingLinkMode: false,
  missingLinkStartNode: null,
  view: null,
  dragStart: null,
  pointerStart: null,
  pointerMoved: false,
  clearSelectionOnPointerUp: false,
  isPanning: false,
  isDraggingEndpoint: false,
  activePointerId: null,
  touchPointers: new Map(),
  pinchGesture: null,
  lastTapAt: 0,
  basemap: "road",
  otherTazVisibility: Number.isFinite(storedOtherTazVisibility)
    ? Math.max(0, Math.min(100, storedOtherTazVisibility))
    : 55,
  maplibreMap: null,
  maplibreLoaded: false,
  drawPending: false,
  canvasPreviewActive: false,
  canvasPreview: { scale: 1, x: 0, y: 0 },
  interactionDrawTimer: null,
  sourceProjectionCache: new WeakMap(),
  contextConnector: null,
  undoStack: [],
  redoStack: [],
  importedCc: null,
  importedSource: "",
  missingLinks: validMissingLinks(storedMissingLinks),
  missingLinksFromStorage: Array.isArray(storedMissingLinks),
  layers: {
    allTaz: true,
    gstdm: true,
    majorNodes: true,
    nonMajorNodes: true,
    connectors: true,
    hereMiss: true,
    centroids: true,
    tazLabels: true,
    newTaz: false,
    newConnectors: false,
  },
  layerOrder: [
    "tazLabels",
    "centroids",
    "connectors",
    "hereMiss",
    "newConnectors",
    "newTaz",
    "majorNodes",
    "nonMajorNodes",
    "gstdm",
    "allTaz",
  ],
  draggedLayer: null,
  layerDragPointerId: null,
  inspectorNoteKey: null,
  inspectorTab: "cc",
  inspectorRenderKey: "",
  inspectorResizePointerId: null,
  hoveredTazId: null,
  hoveredNodeId: null,
  hoveredNode: null,
  statusMenuTazId: null,
  crossTazConflictTazIds: new Set(),
  crossTazConflictNodesByTaz: new Map(),
  crossTazConflictFilterReady: false,
  crossTazConflictFilterLoading: false,
  changed607TazIds: new Set(),
  autoFixedSharedTazIds: new Set(),
  edits: readStoredJson(STORAGE_KEYS.edits, {}),
  legacyNewEdits: readStoredJson(LEGACY_NEW_STORAGE_KEYS.edits, {}),
  legacyNewImportedCc: readStoredJson(LEGACY_NEW_STORAGE_KEYS.importedCc, null),
};

const qs = (id) => document.getElementById(id);
const SOURCE_PROJ =
  "+proj=lcc +lat_0=0 +lon_0=-83.5 +lat_1=31.4166666666667 +lat_2=34.2833333333333 +x_0=0 +y_0=0 +datum=NAD83 +units=us-ft +no_defs +type=crs";
const MIN_CC_ANGLE = 70;

function toast(message) {
  const el = qs("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 2800);
}

function status(message) {
  qs("statusText").textContent = message;
}

const MAPLIBRE_LAYER_GROUPS = Object.freeze({
  allTaz: ["global-taz-fill", "global-taz-outline", "global-taz-hover-fill", "global-taz-hover-outline", "global-taz-current-fill", "global-taz-current-outline"],
  gstdm: ["gstdm-links"],
  majorNodes: ["major-nodes"],
  nonMajorNodes: ["node-clusters", "node-cluster-count", "candidate-nodes-preview", "non-major-nodes"],
  connectors: ["connectors-live", "current-taz-connectors", "connector-selected", "connector-labels", "current-connector-labels"],
  hereMiss: ["here-miss-links", "here-miss-selected"],
  centroids: ["global-centroid-markers", "global-current-centroid-marker"],
  tazLabels: ["global-taz-labels", "global-current-taz-label"],
  newTaz: ["new-taz-fill", "new-taz-outline", "new-centroid-markers", "new-taz-labels"],
  newConnectors: ["new-connectors"],
});

const OTHER_TAZ_PAINT = Object.freeze([
  ["global-taz-fill", "fill-opacity", 0.16],
  ["global-taz-outline", "line-opacity", 0.75],
  ["connectors-live", "line-opacity", 0.75],
  ["connector-labels", "text-opacity", 0.9],
  ["global-centroid-markers", "icon-opacity", 0.8],
  ["global-taz-labels", "text-opacity", 0.85],
]);

function integerTazId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.trunc(numeric)) : String(value ?? "").replace(/\.0+$/, "");
}

function formatConnectorLabel(ccPt, tazId) {
  const raw = String(ccPt || "");
  const separator = raw.indexOf("_");
  const suffix = separator >= 0 && separator < raw.length - 1 ? raw.slice(separator + 1) : raw;
  return `TAZ ${integerTazId(tazId)} - ${suffix}`;
}

function otherTazOpacity(maximum) {
  return Number((maximum * state.otherTazVisibility / 100).toFixed(3));
}

function projectedGeometryToLonLat(geometry) {
  if (!geometry) return null;
  const convert = (coordinates) => typeof coordinates[0] === "number"
    ? sourceToLonLat(coordinates)
    : coordinates.map(convert);
  return { type: geometry.type, coordinates: convert(geometry.coordinates) };
}

function showWarning(message) {
  const dialog = qs("warningDialog");
  qs("warningDialogMessage").textContent = String(message || "Please review this manual override.");
  if (!dialog.open) dialog.showModal();
}

function hideWarning() {
  const dialog = qs("warningDialog");
  if (dialog.open) dialog.close();
}

function mapViewportSourceBounds() {
  if (!state.maplibreLoaded || !state.view) return null;
  const visible = visibleWorldBounds();
  const padding = Math.max(
    Number(state.data?.contextFeet || 0),
    Math.max(visible.maxX - visible.minX, visible.maxY - visible.minY) * 0.18
  );
  return {
    minX: visible.minX - padding,
    minY: visible.minY - padding,
    maxX: visible.maxX + padding,
    maxY: visible.maxY + padding,
  };
}

function connectorGeoJson() {
  const bounds = mapViewportSourceBounds();
  const connectors = bounds
    ? querySpatialGrid(state.connectorGrid, bounds).filter((connector) => (
        boundsIntersect(connector._bounds, bounds)
        && (!state.activeGlobalReviewChunk
          || state.globalReviewChunkByTaz.get(String(connector.tazId)) === state.activeGlobalReviewChunk)
      ))
    : [];
  return {
    type: "FeatureCollection",
    features: connectors.map((connector) => ({
      type: "Feature",
      properties: {
        cc_pt: String(connector.ccPt || ""),
        display_label: formatConnectorLabel(connector.ccPt, connector.tazId),
        taz_id: String(connector.tazId || ""),
        node_id: String(connector.nodeId || ""),
      },
      geometry: projectedGeometryToLonLat(connector.geom),
    })).filter((feature) => feature.geometry),
  };
}

function tazGeoJson() {
  const bounds = mapViewportSourceBounds();
  const currentTazId = String(state.payload?.tazId || "");
  const tazs = bounds
    ? (state.data?.tazs || []).filter((taz) => (
        (!state.activeGlobalReviewChunk
          || state.globalReviewChunkByTaz.get(String(taz.id)) === state.activeGlobalReviewChunk)
        && (boundsIntersect(taz._bounds, bounds) || String(taz.id) === currentTazId)
      ))
    : [];
  return {
    type: "FeatureCollection",
    features: tazs.map((taz) => ({
      type: "Feature",
      properties: { taz_id: String(taz.id || "") },
      geometry: projectedGeometryToLonLat(taz.geom),
    })).filter((feature) => feature.geometry),
  };
}

function centroidGeoJson() {
  const centroids = state.activeGlobalReviewChunk
    ? (state.data?.centroids || []).filter(
        (centroid) => state.globalReviewChunkByTaz.get(String(centroid.id)) === state.activeGlobalReviewChunk
      )
    : (state.data?.centroids || []);
  return {
    type: "FeatureCollection",
    features: centroids.map((centroid) => ({
      type: "Feature",
      properties: { taz_id: String(centroid.id || "") },
      geometry: {
        type: "Point",
        coordinates: sourceToLonLat([centroid.x, centroid.y]),
      },
    })),
  };
}

function applyConnectorEdits(connectors, saved) {
  if (!saved) return connectors;
  const deleted = new Set(saved.deleted || []);
  const active = connectors.filter((connector) => !deleted.has(connector.ccPt));
  for (const connector of active) {
    const edit = saved.connectors?.[connector.ccPt];
    if (edit) Object.assign(connector, edit);
  }
  if (saved.added) active.push(...structuredClone(saved.added));
  return active;
}

function buildLegacyNewConnectors() {
  if (!state.newData) return [];
  const imported = state.legacyNewImportedCc?.byTaz || null;
  const centroidById = new Map(
    (state.newData.centroids || []).map((centroid) => [String(centroid.id), centroid])
  );
  const rows = [];
  for (const item of state.newData.tazOrder || []) {
    const tazId = String(item.id);
    let connectors = structuredClone(state.newConnectorsByTaz.get(tazId) || []);
    if (imported) {
      connectors = (imported[tazId] || []).flatMap((row, index) => {
        const node = state.nodeById.get(CcFileLoader.cleanId(row.nodeId));
        const centroid = centroidById.get(tazId);
        const geometry = row.geometry || (node && centroid
          ? { type: "LineString", coordinates: [[centroid.x, centroid.y], [node.x, node.y]] }
          : null);
        if (!geometry) return [];
        return [{
          ccPt: row.ccPt || `${tazId}_UPLOAD${index + 1}`,
          nodeId: row.nodeId,
          geom: geometry,
        }];
      });
    }
    connectors = applyConnectorEdits(connectors, state.legacyNewEdits[tazId]);
    for (const connector of connectors) rows.push({ ...connector, tazId });
  }
  return rows;
}

function newConnectorGeoJson() {
  return {
    type: "FeatureCollection",
    features: state.newConnectors.map((connector) => ({
      type: "Feature",
      properties: {
        cc_pt: String(connector.ccPt || ""),
        taz_id: String(connector.tazId || ""),
        node_id: String(connector.nodeId || ""),
      },
      geometry: projectedGeometryToLonLat(connector.geom),
    })).filter((feature) => feature.geometry),
  };
}

function missingLinkGeoJson() {
  return {
    type: "FeatureCollection",
    features: state.missingLinks.map((link) => ({
      type: "Feature",
      properties: {
        pair_key: String(link.pairKey || ""),
        a: String(link.a || ""),
        b: String(link.b || ""),
        lanes: Number.isFinite(Number(link.lanes)) ? Number(link.lanes) : MISSING_LINK_DEFAULTS.lanes,
        here_miss: Number.isFinite(Number(link.hereMiss)) ? Number(link.hereMiss) : MISSING_LINK_DEFAULTS.hereMiss,
        fclass: Number.isFinite(Number(link.fclass)) ? Number(link.fclass) : MISSING_LINK_DEFAULTS.fclass,
      },
      geometry: projectedGeometryToLonLat({
        type: "LineString",
        coordinates: [link.aCoord, link.bCoord],
      }),
    })).filter((feature) => feature.geometry),
  };
}

function centroidTriangleImage(size = 48) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.beginPath();
  ctx.moveTo(size / 2, 4);
  ctx.lineTo(size - 4, size - 5);
  ctx.lineTo(4, size - 5);
  ctx.closePath();
  ctx.fillStyle = "#d40000";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

function mapLibreStyle() {
  const vector = state.data.vectorTiles;
  const vectorTileUrl = `${new URL("data/mvt/", document.baseURI).href}{z}/{x}/{y}.pbf?v=${vector.generalizationVersion || 1}`;
  return {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      road: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© OpenStreetMap contributors",
      },
      satellite: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 18,
        attribution: "Tiles © Esri",
      },
      qaqc: {
        type: "vector",
        tiles: [vectorTileUrl],
        minzoom: vector.minzoom,
        maxzoom: vector.maxzoom,
        bounds: vector.bounds,
      },
      "global-taz-live": { type: "geojson", data: tazGeoJson() },
      "global-centroids-live": { type: "geojson", data: centroidGeoJson() },
      "connectors-live": { type: "geojson", data: connectorGeoJson() },
      "new-connectors-live": { type: "geojson", data: newConnectorGeoJson() },
      "here-miss-live": { type: "geojson", data: missingLinkGeoJson() },
    },
    layers: [
      { id: "road-basemap", type: "raster", source: "road", paint: { "raster-fade-duration": 0 } },
      { id: "satellite-basemap", type: "raster", source: "satellite", layout: { visibility: "none" }, paint: { "raster-fade-duration": 0 } },
      { id: "global-taz-fill", type: "fill", source: "global-taz-live", paint: { "fill-color": "#377dd7", "fill-opacity": otherTazOpacity(0.16) } },
      { id: "global-taz-outline", type: "line", source: "global-taz-live", paint: { "line-color": "#165bb1", "line-width": 2.25, "line-opacity": otherTazOpacity(0.75) } },
      { id: "new-taz-fill", type: "fill", source: "qaqc", "source-layer": "taz", layout: { visibility: "none" }, paint: { "fill-color": "#38a169", "fill-opacity": 0.12 } },
      { id: "new-taz-outline", type: "line", source: "qaqc", "source-layer": "taz", layout: { visibility: "none" }, paint: { "line-color": "#23814b", "line-width": 2, "line-opacity": 0.8 } },
      { id: "gstdm-links", type: "line", source: "qaqc", "source-layer": "gstdm", paint: { "line-color": "#080b10", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.7, 12, 2.1, 16, 3.0], "line-opacity": 0.9 } },
      { id: "major-nodes", type: "circle", source: "qaqc", "source-layer": "nodes", filter: ["all", ["!=", ["get", "outside_ga"], true], ["<=", ["coalesce", ["get", "major_level"], 99], 2]], paint: { "circle-color": "#df252b", "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 5], "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.7 } },
      { id: "node-clusters", type: "circle", source: "qaqc", "source-layer": "node_clusters", minzoom: 8, maxzoom: 11, paint: { "circle-color": "#26875a", "circle-opacity": 0.55, "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 2.5, 100, 3.5, 1000, 5], "circle-stroke-color": "rgba(255,255,255,0.9)", "circle-stroke-width": 0.8 } },
      { id: "node-cluster-count", type: "symbol", source: "qaqc", "source-layer": "node_clusters", minzoom: 8, maxzoom: 11, layout: { "text-field": ["to-string", ["get", "count"]], "text-size": 8, "text-offset": [0, 1.15], "text-allow-overlap": false }, paint: { "text-color": "#155f42", "text-halo-color": "rgba(255,255,255,0.96)", "text-halo-width": 1.2 } },
      { id: "candidate-nodes-preview", type: "circle", source: "qaqc", "source-layer": "candidate_nodes", minzoom: 11, maxzoom: 12, paint: { "circle-color": "#248653", "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.78, 11.9, 0.92], "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.4, 11.9, 3.5], "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.55 } },
      { id: "non-major-nodes", type: "circle", source: "qaqc", "source-layer": "nodes", filter: ["any", ["==", ["get", "outside_ga"], true], [">", ["coalesce", ["get", "major_level"], 99], 2]], paint: { "circle-color": "#248653", "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.2, 16, 4.5], "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.55 } },
      { id: "connectors-live", type: "line", source: "connectors-live", paint: { "line-color": "#d9252a", "line-width": 2.5, "line-opacity": otherTazOpacity(0.75) } },
      { id: "new-connectors", type: "line", source: "new-connectors-live", layout: { visibility: "none" }, paint: { "line-color": "#0f9d78", "line-width": 3, "line-opacity": 0.9, "line-dasharray": [1.4, 0.8] } },
      { id: "here-miss-links", type: "line", source: "here-miss-live", paint: { "line-color": "#8a35c5", "line-width": 5, "line-opacity": 0.95, "line-dasharray": [2, 1.2] } },
      { id: "here-miss-selected", type: "line", source: "here-miss-live", filter: ["==", ["get", "pair_key"], ""], paint: { "line-color": "#ff8500", "line-width": 9, "line-opacity": 1 } },
      { id: "current-taz-connectors", type: "line", source: "connectors-live", filter: ["==", ["get", "taz_id"], ""], paint: { "line-color": "#d9252a", "line-width": 4.5, "line-opacity": 0.96 } },
      { id: "connector-selected", type: "line", source: "connectors-live", filter: ["==", ["get", "cc_pt"], ""], paint: { "line-color": "#ffae00", "line-width": 7 } },
      { id: "connector-labels", type: "symbol", source: "connectors-live", minzoom: 10, layout: { "symbol-placement": "line", "text-field": ["get", "display_label"], "text-size": 10, "text-allow-overlap": false }, paint: { "text-color": "#9d2226", "text-opacity": otherTazOpacity(0.9), "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.5 } },
      { id: "current-connector-labels", type: "symbol", source: "connectors-live", minzoom: 9, filter: ["==", ["get", "taz_id"], ""], layout: { "symbol-placement": "line", "text-field": ["get", "display_label"], "text-size": 12, "text-allow-overlap": true }, paint: { "text-color": "#98171c", "text-opacity": 0.98, "text-halo-color": "#ffffff", "text-halo-width": 2.5 } },
      { id: "global-centroid-markers", type: "symbol", source: "global-centroids-live", layout: { "icon-image": "centroid-triangle", "icon-size": ["interpolate", ["linear"], ["zoom"], 7, 0.28, 13, 0.46, 17, 0.58], "icon-allow-overlap": true }, paint: { "icon-opacity": otherTazOpacity(0.8) } },
      { id: "global-current-centroid-marker", type: "symbol", source: "global-centroids-live", filter: ["==", ["get", "taz_id"], ""], layout: { "icon-image": "centroid-triangle", "icon-size": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 13, 0.68, 17, 0.82], "icon-allow-overlap": true }, paint: { "icon-opacity": 1 } },
      { id: "global-taz-labels", type: "symbol", source: "global-centroids-live", layout: { "text-field": ["get", "taz_id"], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 12, 15], "text-offset": [0, -1.4], "text-allow-overlap": true }, paint: { "text-color": "#143b70", "text-opacity": otherTazOpacity(0.85), "text-halo-color": "rgba(255,255,255,0.82)", "text-halo-width": 1.5 } },
      { id: "new-centroid-markers", type: "symbol", source: "qaqc", "source-layer": "centroids", layout: { visibility: "none", "icon-image": "centroid-triangle", "icon-size": ["interpolate", ["linear"], ["zoom"], 7, 0.24, 13, 0.4, 17, 0.52], "icon-allow-overlap": true }, paint: { "icon-opacity": 0.75 } },
      { id: "new-taz-labels", type: "symbol", source: "qaqc", "source-layer": "centroids", layout: { visibility: "none", "text-field": ["concat", "New ", ["to-string", ["get", "taz_id"]]], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9, 12, 13], "text-offset": [0, -1.3], "text-allow-overlap": false }, paint: { "text-color": "#17633c", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 } },
      { id: "global-taz-hover-fill", type: "fill", source: "global-taz-live", filter: ["==", ["get", "taz_id"], ""], paint: { "fill-color": "#ff9123", "fill-opacity": 0.24 } },
      { id: "global-taz-hover-outline", type: "line", source: "global-taz-live", filter: ["==", ["get", "taz_id"], ""], paint: { "line-color": "#e66a00", "line-width": 4.5 } },
      { id: "global-taz-current-fill", type: "fill", source: "global-taz-live", filter: ["==", ["get", "taz_id"], ""], paint: { "fill-color": "#277fdc", "fill-opacity": 0.38 } },
      { id: "global-taz-current-outline", type: "line", source: "global-taz-live", filter: ["==", ["get", "taz_id"], ""], paint: { "line-color": "#075fc7", "line-width": 5 } },
      { id: "global-current-taz-label", type: "symbol", source: "global-centroids-live", filter: ["==", ["get", "taz_id"], ""], layout: { "text-field": ["get", "taz_id"], "text-size": 24, "text-offset": [0, -1.5], "text-allow-overlap": true }, paint: { "text-color": "#075fc7", "text-halo-color": "#ffffff", "text-halo-width": 3 } },
    ],
  };
}

async function initMapLibreMap() {
  if (!window.maplibregl || !window.proj4) throw new Error("MapLibre GL or projection library did not load.");
  state.maplibreMap = new maplibregl.Map({
    container: "maplibreMap",
    style: mapLibreStyle(),
    center: [-84.4, 33.75],
    zoom: 8,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    renderWorldCopies: false,
  });
  state.maplibreMap.on("styleimagemissing", (event) => {
    if (event.id === "centroid-triangle" && !state.maplibreMap.hasImage(event.id)) {
      state.maplibreMap.addImage(event.id, centroidTriangleImage());
    }
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (state.maplibreMap.isStyleLoaded()) finish();
      else reject(new Error("MapLibre style initialization timed out after 10 seconds."));
    }, 10000);
    state.maplibreMap.once("style.load", finish);
    state.maplibreMap.once("load", finish);
    state.maplibreMap.on("error", (event) => {
      console.warn("MapLibre source or tile warning", event.error || event);
    });
  });
  state.maplibreLoaded = true;
  if (!state.maplibreMap.hasImage("centroid-triangle")) {
    state.maplibreMap.addImage("centroid-triangle", centroidTriangleImage());
  }
  state.maplibreMap.on("move", () => {
    syncViewFromMapLibre();
    scheduleDraw();
  });
  state.maplibreMap.on("moveend", () => {
    qs("maplibreMap").dataset.mapZoom = state.maplibreMap.getZoom().toFixed(2);
    refreshMapLibreViewportSources();
    scheduleViewportLoad();
  });
  qs("maplibreMap").dataset.mapZoom = state.maplibreMap.getZoom().toFixed(2);
  syncMapLibreLayerState();
  applyOtherTazVisibility();
  updateMapLibreSelection();
}

function refreshMapLibreConnectors() {
  if (!state.maplibreLoaded) return;
  const data = connectorGeoJson();
  state.maplibreMap.getSource("connectors-live")?.setData(data);
  qs("maplibreMap").dataset.viewportConnectors = String(data.features.length);
}

function refreshMapLibreCentroids() {
  if (!state.maplibreLoaded) return;
  state.maplibreMap.getSource("global-centroids-live")?.setData(centroidGeoJson());
}

function refreshMapLibreViewportSources() {
  if (!state.maplibreLoaded) return;
  const data = tazGeoJson();
  state.maplibreMap.getSource("global-taz-live")?.setData(data);
  qs("maplibreMap").dataset.viewportTazs = String(data.features.length);
  refreshMapLibreConnectors();
}

function refreshMapLibreMissingLinks() {
  if (!state.maplibreLoaded) return;
  state.maplibreMap.getSource("here-miss-live")?.setData(missingLinkGeoJson());
}

function updateMapLibreSelection() {
  if (!state.maplibreLoaded) return;
  const tazId = String(state.payload?.tazId || "");
  const hoverId = String(state.hoveredTazId || "");
  const ccPt = String(state.selected?.ccPt || "");
  const missingPairKey = String(state.selectedMissingLink?.pairKey || "");
  for (const layer of ["global-taz-current-fill", "global-taz-current-outline", "global-current-taz-label"]) {
    state.maplibreMap.setFilter(layer, ["==", ["get", "taz_id"], tazId]);
  }
  for (const layer of ["current-taz-connectors", "current-connector-labels", "global-current-centroid-marker"]) {
    state.maplibreMap.setFilter(layer, ["==", ["get", "taz_id"], tazId]);
  }
  for (const layer of ["global-taz-fill", "global-taz-outline", "connectors-live", "connector-labels", "global-centroid-markers"]) {
    state.maplibreMap.setFilter(layer, ["!=", ["get", "taz_id"], tazId]);
  }
  state.maplibreMap.setFilter("global-taz-labels", ["!=", ["get", "taz_id"], tazId]);
  for (const layer of ["global-taz-hover-fill", "global-taz-hover-outline"]) {
    state.maplibreMap.setFilter(layer, ["==", ["get", "taz_id"], hoverId]);
  }
  state.maplibreMap.setFilter("connector-selected", ["==", ["get", "cc_pt"], ccPt]);
  state.maplibreMap.setFilter("here-miss-selected", ["==", ["get", "pair_key"], missingPairKey]);
}

function syncMapLibreLayerState() {
  if (!state.maplibreLoaded) return;
  for (const [group, layers] of Object.entries(MAPLIBRE_LAYER_GROUPS)) {
    for (const layer of layers) {
      if (state.maplibreMap.getLayer(layer)) state.maplibreMap.setLayoutProperty(layer, "visibility", state.layers[group] ? "visible" : "none");
    }
  }
  const roadVisible = state.basemap === "road" ? "visible" : "none";
  const satelliteVisible = state.basemap === "satellite" ? "visible" : "none";
  state.maplibreMap.setLayoutProperty("road-basemap", "visibility", roadVisible);
  state.maplibreMap.setLayoutProperty("satellite-basemap", "visibility", satelliteVisible);
  syncMapLibreLayerOrder();
}

function syncMapLibreLayerOrder() {
  if (!state.maplibreLoaded) return;
  for (const group of [...state.layerOrder].reverse()) {
    for (const layer of MAPLIBRE_LAYER_GROUPS[group] || []) {
      if (state.maplibreMap.getLayer(layer)) state.maplibreMap.moveLayer(layer);
    }
  }
  // Connector text stays readable above selection highlighting and every draggable group.
  for (const layer of ["connector-labels", "current-connector-labels"]) {
    if (state.maplibreMap.getLayer(layer)) state.maplibreMap.moveLayer(layer);
  }
}

function updateOtherTazVisibilityUi() {
  const slider = qs("otherTazVisibility");
  const output = qs("otherTazVisibilityValue");
  if (slider) slider.value = String(state.otherTazVisibility);
  if (output) output.textContent = `${Math.round(state.otherTazVisibility)}%`;
}

function applyOtherTazVisibility() {
  updateOtherTazVisibilityUi();
  if (!state.maplibreLoaded) return;
  for (const [layer, property, maximum] of OTHER_TAZ_PAINT) {
    if (state.maplibreMap.getLayer(layer)) state.maplibreMap.setPaintProperty(layer, property, otherTazOpacity(maximum));
  }
}

function syncMapToView() {
  if (!state.maplibreLoaded || !state.view) return;
  const corners = [
    sourceToLonLat([state.view.minX, state.view.minY]),
    sourceToLonLat([state.view.maxX, state.view.maxY]),
  ];
  const west = Math.min(corners[0][0], corners[1][0]);
  const east = Math.max(corners[0][0], corners[1][0]);
  const south = Math.min(corners[0][1], corners[1][1]);
  const north = Math.max(corners[0][1], corners[1][1]);
  state.maplibreMap.fitBounds([[west, south], [east, north]], { padding: 0, duration: 0 });
  syncViewFromMapLibre();
}

function syncViewFromMapLibre() {
  if (!state.maplibreLoaded) return;
  const bounds = state.maplibreMap.getBounds();
  const southWest = lonLatToSource([bounds.getWest(), bounds.getSouth()]);
  const northEast = lonLatToSource([bounds.getEast(), bounds.getNorth()]);
  state.view = {
    minX: Math.min(southWest[0], northEast[0]),
    maxX: Math.max(southWest[0], northEast[0]),
    minY: Math.min(southWest[1], northEast[1]),
    maxY: Math.max(southWest[1], northEast[1]),
  };
}

async function init() {
  state.canvas = qs("mapCanvas");
  state.ctx = state.canvas.getContext("2d");
  bindControls();
  bindCanvas();
  resizeCanvas();
  window.addEventListener("resize", () => {
    clampInspectorWidth();
    resizeCanvas();
    state.maplibreMap?.resize();
    scheduleDraw();
  });

  status("Loading 1/4: Global review index...");
  const [newData, globalData, changed607Data, autoFixedSharedData] = await Promise.all([
    fetchJson("data/core.json"),
    fetchJson("data/global-review.json"),
    fetchJson("data/review-changed-607.json"),
    fetchJson("data/review-auto-fixed-shared.json"),
  ]);
  status("Loading 2/4: preparing TAZ review index...");
  state.newData = newData;
  state.newTazIds = new Set((newData.tazOrder || []).map((item) => String(item.id)));
  state.changed607TazIds = new Set(
    (changed607Data.tazIds || []).map((id) => String(id))
  );
  state.autoFixedSharedTazIds = new Set(
    (autoFixedSharedData.tazIds || []).map((id) => String(id))
  );
  state.data = {
    ...newData,
    ...globalData,
    tazs: globalData.tazs || [],
    connectors: globalData.connectors || [],
    contextFeet: newData.contextFeet,
    connectorNodes: newData.connectorNodes,
    defaultInputs: newData.defaultInputs,
    defaultMissingLinks: newData.defaultMissingLinks,
    tileManifest: newData.tileManifest,
    vectorTiles: newData.vectorTiles,
  };
  if (!state.missingLinksFromStorage) {
    state.missingLinks = validMissingLinks(state.data.defaultMissingLinks);
  }
  updateMissingLinkModeUi();
  state.tileManifest = await fetchJson(newData.tileManifest);
  state.index = state.data;
  state.tazOrder = sortTazOrder(state.data.tazOrder);
  initializeGlobalReviewChunks(globalData);
  if (state.globalReviewChunks && state.tazOrder.length) {
    status("Loading 3/4: first Global TAZ / CC chunk...");
    await ensureGlobalReviewChunkForTaz(state.tazOrder[0].id, false);
  }
  buildDataIndexes();
  if (state.legacyNewImportedCc?.byTaz) {
    await ensureNodesByIds(
      Object.values(state.legacyNewImportedCc.byTaz)
        .flatMap((rows) => rows.map((row) => row.nodeId))
    );
  }
  state.newConnectors = buildLegacyNewConnectors();
  restoreImportedCc();
  rebuildGlobalConnectorIndex();
  status("Loading 4/4: MapLibre map style...");
  await initMapLibreMap();
  updateImportedCcUi();
  renderQueue();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  resizeCanvas();
  await goToTaz(state.tazOrder[0].id);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`${url}: timed out after 30 seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function initializeGlobalReviewChunks(globalData) {
  state.globalReviewChunks = globalData.globalReviewChunks || null;
  state.globalReviewChunkByTaz = new Map();
  state.globalReviewChunkUrls = new Map();
  state.globalReviewChunkPromises = new Map();
  state.loadedGlobalReviewChunks = new Set();
  for (const item of state.globalReviewChunks?.items || []) {
    state.globalReviewChunkUrls.set(String(item.id), String(item.url));
  }
  for (const item of globalData.tazOrder || []) {
    if (item.chunk != null) state.globalReviewChunkByTaz.set(String(item.id), String(item.chunk));
  }
  state.activeGlobalReviewChunk = state.globalReviewChunks?.items?.length
    ? String(state.globalReviewChunks.items[0].id)
    : null;
  updateDataBlockSelect();
}

function activeReviewTazOrder() {
  if (!state.activeGlobalReviewChunk) return state.tazOrder;
  return state.tazOrder.filter(
    (item) => String(item.chunk) === String(state.activeGlobalReviewChunk)
  );
}

function updateDataBlockSelect() {
  const select = qs("dataBlockSelect");
  if (!select) return;
  select.replaceChildren();
  for (const [index, item] of (state.globalReviewChunks?.items || []).entries()) {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = `Block ${index + 1}: TAZ ${item.firstTaz}-${item.lastTaz} (${Number(item.tazs).toLocaleString()} TAZ / ${Number(item.connectors).toLocaleString()} CC)`;
    select.appendChild(option);
  }
  select.value = state.activeGlobalReviewChunk || "";
  select.disabled = select.options.length <= 1;
}

async function activateGlobalReviewChunk(chunkId, goToFirst = true) {
  const id = String(chunkId ?? "");
  if (!state.globalReviewChunkUrls.has(id)) throw new Error(`Global review block ${id} was not found.`);
  const alreadyActive = id === String(state.activeGlobalReviewChunk)
    && state.loadedGlobalReviewChunks.size === 1
    && state.loadedGlobalReviewChunks.has(id);
  if (!alreadyActive) {
    status(`Loading Global TAZ / CC block ${Number(id) + 1}...`);
    state.activeGlobalReviewChunk = id;
    state.data.tazs = [];
    state.data.connectors = [];
    state.dataIndexesReady = false;
    state.globalReviewChunkPromises = new Map();
    state.loadedGlobalReviewChunks = new Set();
    state.tazById = new Map();
    state.connectorsByTaz = new Map();
    state.globalConnectors = [];
    state.connectorGrid = new Map();
    await ensureGlobalReviewChunk(id, false);
    buildDataIndexes();
    rebuildGlobalConnectorIndex();
  }
  updateDataBlockSelect();
  renderQueue();
  refreshMapLibreCentroids();
  refreshMapLibreViewportSources();
  if (goToFirst) {
    const first = activeReviewTazOrder()[0];
    if (first) await goToTaz(first.id);
  }
}

function mergeGlobalReviewChunk(chunk) {
  const chunkId = String(chunk.chunk ?? "");
  if (!chunkId || state.loadedGlobalReviewChunks.has(chunkId)) return false;
  for (const taz of chunk.tazs || []) {
    taz._bounds = geomBounds(taz.geom);
    state.data.tazs.push(taz);
    if (state.dataIndexesReady) state.tazById.set(String(taz.id), taz);
  }
  for (const connector of chunk.connectors || []) {
    state.data.connectors.push(connector);
    if (state.dataIndexesReady) {
      const tazId = String(connector.tazId);
      if (!state.connectorsByTaz.has(tazId)) state.connectorsByTaz.set(tazId, []);
      state.connectorsByTaz.get(tazId).push(connector);
    }
  }
  state.loadedGlobalReviewChunks.add(chunkId);
  const mapElement = qs("maplibreMap");
  if (mapElement) {
    mapElement.dataset.loadedReviewChunks = String(state.loadedGlobalReviewChunks.size);
    mapElement.dataset.loadedReviewTazs = String(state.data.tazs.length);
    mapElement.dataset.loadedReviewConnectors = String(state.data.connectors.length);
  }
  return true;
}

async function ensureGlobalReviewChunk(chunkId, refresh = true) {
  const id = String(chunkId ?? "");
  if (!id || state.loadedGlobalReviewChunks.has(id)) return false;
  if (!state.globalReviewChunkPromises.has(id)) {
    const url = state.globalReviewChunkUrls.get(id);
    if (!url) throw new Error(`Global review chunk ${id} is not in the manifest.`);
    state.globalReviewChunkPromises.set(
      id,
      fetchJson(url)
        .then((chunk) => mergeGlobalReviewChunk(chunk))
        .catch((error) => {
          state.globalReviewChunkPromises.delete(id);
          throw error;
        })
    );
  }
  const loaded = await state.globalReviewChunkPromises.get(id);
  if (loaded && refresh && state.dataIndexesReady) {
    rebuildGlobalConnectorIndex();
    refreshMapLibreViewportSources();
  }
  return loaded;
}

async function ensureGlobalReviewChunkForTaz(tazId, refresh = true) {
  if (!state.globalReviewChunks) return false;
  return ensureGlobalReviewChunk(state.globalReviewChunkByTaz.get(String(tazId)), refresh);
}

async function ensureGlobalReviewChunksForBounds(bounds) {
  if (!state.globalReviewChunks || !bounds || state.activeGlobalReviewChunk) return false;
  const chunkIds = new Set();
  for (const centroid of state.data.centroids || []) {
    if (
      centroid.x >= bounds.minX && centroid.x <= bounds.maxX
      && centroid.y >= bounds.minY && centroid.y <= bounds.maxY
    ) {
      const chunkId = state.globalReviewChunkByTaz.get(String(centroid.id));
      if (chunkId && !state.loadedGlobalReviewChunks.has(chunkId)) chunkIds.add(chunkId);
    }
  }
  if (!chunkIds.size) return false;
  const loaded = await Promise.all(
    Array.from(chunkIds, (chunkId) => ensureGlobalReviewChunk(chunkId, false))
  );
  if (loaded.some(Boolean) && state.dataIndexesReady) {
    rebuildGlobalConnectorIndex();
    refreshMapLibreViewportSources();
    return true;
  }
  return false;
}

async function ensureAllGlobalReviewChunks() {
  if (!state.globalReviewChunks) return;
  const remaining = Array.from(state.globalReviewChunkUrls.keys())
    .filter((chunkId) => !state.loadedGlobalReviewChunks.has(chunkId));
  if (!remaining.length) return;
  status(`Loading ${remaining.length} remaining Global TAZ / CC data chunk(s) for export...`);
  await Promise.all(remaining.map((chunkId) => ensureGlobalReviewChunk(chunkId, false)));
  if (state.dataIndexesReady) rebuildGlobalConnectorIndex();
}

async function restoreSingleGlobalReviewChunk(chunkId, tazId) {
  if (!chunkId || (
    state.loadedGlobalReviewChunks.size === 1
    && state.loadedGlobalReviewChunks.has(String(chunkId))
  )) return;
  await activateGlobalReviewChunk(chunkId, false);
  if (
    tazId
    && state.globalReviewChunkByTaz.get(String(tazId)) === String(chunkId)
  ) {
    await goToTaz(tazId, true);
  }
}

function bindControls() {
  qs("prevBtn").addEventListener("click", () => shiftTaz(-1));
  qs("nextBtn").addEventListener("click", () => shiftTaz(1));
  qs("zoomAllBtn").addEventListener("click", zoomAll);
  qs("undoBtn").addEventListener("click", undoEdit);
  qs("redoBtn").addEventListener("click", redoEdit);
  qs("jumpBtn").addEventListener("click", () => goToTaz(qs("jumpInput").value.trim()));
  qs("dataBlockSelect").addEventListener("change", (event) => {
    void activateGlobalReviewChunk(event.target.value).catch((error) => {
      console.error(error);
      status(`Failed to load selected data block: ${error.message}`);
      toast(error.message);
    });
  });
  qs("saveBtn").addEventListener("click", saveEdit);
  qs("addCcBtn").addEventListener("click", toggleAddMode);
  qs("addMissingLinkBtn").addEventListener("click", toggleMissingLinkMode);
  qs("loadMissingLinksBtn").addEventListener("click", () => qs("hereMissingFileInput").click());
  qs("hereMissingFileInput").addEventListener("change", importMissingLinkFiles);
  qs("exportMissingLinksBtn").addEventListener("click", showMissingLinksExportDialog);
  qs("closeMissingLinksExportDialogBtn").addEventListener("click", hideMissingLinksExportDialog);
  qs("cancelMissingLinksExportBtn").addEventListener("click", hideMissingLinksExportDialog);
  qs("downloadMissingLinksExportBtn").addEventListener("click", exportMissingLinks);
  qs("reviewedPrevBtn").addEventListener("click", () => markReviewed(-1));
  qs("reviewedBtn").addEventListener("click", () => markReviewed(1));
  qs("closeWarningDialogBtn").addEventListener("click", hideWarning);
  qs("acknowledgeWarningBtn").addEventListener("click", hideWarning);
  qs("finalExportBtn").addEventListener("click", showExportDialog);
  qs("closeExportDialogBtn").addEventListener("click", hideExportDialog);
  qs("cancelExportBtn").addEventListener("click", hideExportDialog);
  qs("downloadFinalExportBtn").addEventListener("click", exportFinalCc);
  qs("tazStatusExportBtn").addEventListener("click", showTazStatusExportDialog);
  qs("closeTazStatusExportDialogBtn").addEventListener("click", hideTazStatusExportDialog);
  qs("cancelTazStatusExportBtn").addEventListener("click", hideTazStatusExportDialog);
  qs("downloadTazStatusExportBtn").addEventListener("click", exportTazQcStatus);
  qs("loadCcBtn").addEventListener("click", () => qs("ccFileInput").click());
  qs("ccFileInput").addEventListener("change", importCcFiles);
  qs("resetBrowserDataBtn").addEventListener("click", resetBrowserData);
  qs("qcNote").addEventListener("input", () => saveQcNoteDraft(false));
  qs("qcNote").addEventListener("change", () => saveQcNoteDraft(true));
  qs("resetCcBtn").addEventListener("click", resetImportedCc);
  qs("clearBtn").addEventListener("click", clearSelection);
  document.querySelectorAll("[data-inspector-tab]").forEach((button) => {
    button.addEventListener("click", () => setInspectorTab(button.dataset.inspectorTab));
  });
  bindToolbarMenus();
  bindInspectorResizer();
  qs("ctxAddCcBtn").addEventListener("click", () => {
    hideContextMenu();
    state.addMode = true;
    updateAddModeUi();
    toast("Tap any node to add CC. Red major nodes require a Warning acknowledgement.");
  });
  qs("ctxDeleteCcBtn").addEventListener("click", () => {
    hideContextMenu();
    deleteSelectedConnector();
  });
  qs("ctxDeleteMissingLinkBtn").addEventListener("click", () => {
    hideMissingLinkContextMenu();
    deleteSelectedMissingLink();
  });
  document.querySelectorAll("[data-taz-status]").forEach((button) => {
    button.addEventListener("click", () => setTazStatus(state.statusMenuTazId, button.dataset.tazStatus));
  });
  document.addEventListener("click", (event) => {
    if (!qs("ccContextMenu").contains(event.target)) hideContextMenu();
    if (!qs("missingLinkContextMenu").contains(event.target)) hideMissingLinkContextMenu();
    if (!qs("tazStatusMenu").contains(event.target)) hideTazStatusMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!qs("ccContextMenu").contains(event.target)) hideContextMenu();
    if (!qs("missingLinkContextMenu").contains(event.target)) hideMissingLinkContextMenu();
    if (!qs("tazStatusMenu").contains(event.target)) hideTazStatusMenu();
  });
  document.addEventListener("pointermove", (event) => {
    if (event.target !== state.canvas && state.hoveredTazId && !state.isPanning && !state.isDraggingEndpoint) {
      updateHoveredTaz(null);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
      hideMissingLinkContextMenu();
      hideTazStatusMenu();
      if (state.missingLinkMode) stopMissingLinkMode();
    }
  });
  qs("queueFilter").addEventListener("change", async (event) => {
    if (event.target.value === "cross-taz-shared-node") {
      if (state.crossTazConflictFilterReady) renderQueue();
      else await refreshCrossTazSharedNodeReview();
      return;
    }
    renderQueue();
  });
  qs("queueList").addEventListener("click", (event) => {
    const row = event.target.closest(".queue-item");
    if (row?.dataset.tazId) goToTaz(row.dataset.tazId);
  });
  qs("queueList").addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".queue-item");
    if (!row?.dataset.tazId) return;
    event.preventDefault();
    showTazStatusMenu(event.clientX, event.clientY, row.dataset.tazId);
  });
  qs("otherTazVisibility").addEventListener("input", (event) => {
    state.otherTazVisibility = Math.max(0, Math.min(100, Number(event.target.value) || 0));
    localStorage.setItem(STORAGE_KEYS.otherTazVisibility, JSON.stringify(state.otherTazVisibility));
    applyOtherTazVisibility();
  });
  updateOtherTazVisibilityUi();
  qs("basemapSelect").addEventListener("change", () => {
    state.basemap = qs("basemapSelect").value;
    updateBasemapAttribution();
    syncMapLibreLayerState();
    scheduleDraw();
  });
  updateBasemapAttribution();
  restoreLayerOrder();
  document.querySelectorAll(".legend input[data-layer]").forEach((input) => {
    input.addEventListener("change", () => {
      state.layers[input.dataset.layer] = input.checked;
      syncMapLibreLayerState();
      draw();
    });
  });
  bindLayerReordering();
  updateMissingLinkModeUi();
}

function bindToolbarMenus() {
  const menus = Array.from(document.querySelectorAll(".toolbar-menu"));
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      for (const other of menus) {
        if (other !== menu) other.removeAttribute("open");
      }
    });
    for (const button of menu.querySelectorAll("button")) {
      button.addEventListener("click", () => menu.removeAttribute("open"));
    }
  }
  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".toolbar-menu")) return;
    for (const menu of menus) menu.removeAttribute("open");
  });
}

function restoreLayerOrder() {
  const container = qs("legendLayers");
  const saved = readStoredJson(STORAGE_KEYS.layerOrder, null);
  const valid = new Set(state.layerOrder);
  if (Array.isArray(saved) && saved.length === valid.size && saved.every((id) => valid.has(id))) state.layerOrder = saved;
  for (const id of state.layerOrder) {
    const row = container.querySelector(`[data-layer-row="${id}"]`);
    if (row) container.appendChild(row);
  }
}

function bindLayerReordering() {
  const container = qs("legendLayers");
  container.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".drag-handle")) return;
    const row = event.target.closest(".legend-layer");
    state.draggedLayer = row;
    state.layerDragPointerId = event.pointerId;
    row.classList.add("dragging");
    event.target.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  container.addEventListener("pointermove", (event) => {
    if (event.pointerId !== state.layerDragPointerId) return;
    const dragged = state.draggedLayer;
    if (!dragged) return;
    const rows = Array.from(container.querySelectorAll(".legend-layer")).filter((row) => row !== dragged);
    const before = rows.find((row) => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    container.insertBefore(dragged, before || null);
    event.preventDefault();
  });
  const finishLayerDrag = (event) => {
    if (event.pointerId !== state.layerDragPointerId) return;
    state.draggedLayer?.classList.remove("dragging");
    state.draggedLayer = null;
    state.layerDragPointerId = null;
    syncLayerOrder();
  };
  container.addEventListener("pointerup", finishLayerDrag);
  container.addEventListener("pointercancel", finishLayerDrag);
}

function syncLayerOrder() {
  state.layerOrder = Array.from(qs("legendLayers").querySelectorAll(".legend-layer"), (row) => row.dataset.layerRow);
  localStorage.setItem(STORAGE_KEYS.layerOrder, JSON.stringify(state.layerOrder));
  syncMapLibreLayerOrder();
  draw();
}

function showExportDialog() {
  qs("exportDialog").showModal();
}

function hideExportDialog() {
  qs("exportDialog").close();
}

function showTazStatusExportDialog() {
  qs("tazStatusExportDialog").showModal();
}

function hideTazStatusExportDialog() {
  qs("tazStatusExportDialog").close();
}

function showMissingLinksExportDialog() {
  if (!state.missingLinks.length) {
    toast("No HERE_MISS links to export yet.");
    return;
  }
  qs("missingLinksExportDialog").showModal();
}

function hideMissingLinksExportDialog() {
  qs("missingLinksExportDialog").close();
}

function bindCanvas() {
  state.canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const pt = eventPoint(event);
    hideMissingLinkContextMenu();
    const missingLink = findMissingLinkAt(pt);
    if (missingLink) {
      hideContextMenu();
      hideTazStatusMenu();
      selectMissingLink(missingLink);
      showMissingLinkContextMenu(event.clientX, event.clientY, missingLink);
      return;
    }
    const connector = findConnectorAt(pt);
    if (connector) {
      hideMissingLinkContextMenu();
      hideTazStatusMenu();
      selectConnector(connector);
      showContextMenu(event.clientX, event.clientY, connector);
    } else {
      hideContextMenu();
      const taz = findTazAt(pt);
      if (taz) showTazStatusMenu(event.clientX, event.clientY, taz.id);
    }
  });
  state.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const pt = eventPoint(event);
    zoomAt(pt.x, pt.y, event.deltaY < 0 ? 0.82 : 1.22);
  });
  state.canvas.addEventListener("dblclick", (event) => {
    const pt = eventPoint(event);
    const labelTaz = findTazLabelAt(pt);
    if (labelTaz) {
      void goToTaz(labelTaz.id);
      event.preventDefault();
      return;
    }
    if (findConnectorAt(pt) || findMissingLinkAt(pt)) return;
    const taz = findTazAt(pt);
    if (taz) {
      void goToTaz(taz.id);
      event.preventDefault();
      return;
    }
    zoomAt(pt.x, pt.y, 0.72);
  });
  state.canvas.addEventListener("pointerdown", (event) => {
    hideContextMenu();
    hideMissingLinkContextMenu();
    hideTazStatusMenu();
    state.clearSelectionOnPointerUp = false;
    const pt = eventPoint(event);
    if (event.pointerType === "touch") {
      state.touchPointers.set(event.pointerId, pt);
      state.canvas.setPointerCapture(event.pointerId);
      if (state.touchPointers.size >= 2) {
        beginPinchGesture();
        event.preventDefault();
        return;
      }
    }
    state.pointerStart = pt;
    state.pointerMoved = false;
    state.activePointerId = event.pointerId;
    state.canvas.setPointerCapture(event.pointerId);
    const nodeHitRadius = event.pointerType === "touch" ? 30 : state.selected || state.missingLinkMode ? 18 : 13;
    const node = findNodeAt(pt, nodeHitRadius);
    if (node && state.missingLinkMode) {
      chooseMissingLinkNode(node);
      event.preventDefault();
      return;
    }
    if (state.selected && endpointHit(pt)) {
      state.isDraggingEndpoint = true;
      state.canvas.classList.add("dragging");
      event.preventDefault();
      return;
    }
    if (node && state.addMode) {
      addConnector(node);
      event.preventDefault();
      return;
    }
    const missingLink = findMissingLinkAt(pt);
    if (missingLink && !state.missingLinkMode) {
      state.addMode = false;
      updateAddModeUi();
      selectMissingLink(missingLink);
      event.preventDefault();
      return;
    }
    const connector = findConnectorAt(pt);
    if (connector && !state.missingLinkMode) {
      state.addMode = false;
      updateAddModeUi();
      selectConnector(connector);
      event.preventDefault();
      return;
    }
    if (node && state.selected) {
      applyEditToNode(node);
      event.preventDefault();
      return;
    }
    const now = Date.now();
    if (event.pointerType === "touch" && now - state.lastTapAt < 320) {
      const taz = findTazLabelAt(pt, 30) || findTazAt(pt);
      if (taz) void goToTaz(taz.id);
      else zoomAt(pt.x, pt.y, 0.78);
      state.lastTapAt = 0;
      event.preventDefault();
      return;
    }
    state.lastTapAt = now;
    state.clearSelectionOnPointerUp = Boolean(state.selected || state.selectedMissingLink);
    state.isPanning = true;
    state.dragStart = pt;
    state.canvas.classList.add("panning");
    event.preventDefault();
  });
  state.canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" && state.touchPointers.has(event.pointerId)) {
      state.touchPointers.set(event.pointerId, eventPoint(event));
      if (state.pinchGesture && state.touchPointers.size >= 2) {
        updatePinchGesture();
        event.preventDefault();
        return;
      }
    }
    if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;
    const pt = eventPoint(event);
    if (state.isDraggingEndpoint) {
      state.pendingNode = nearestEditableNode(pt);
      updateInspector();
      draw(pt);
      event.preventDefault();
      return;
    }
    if (state.isPanning && state.dragStart) {
      if (state.pointerStart && Math.hypot(pt.x - state.pointerStart.x, pt.y - state.pointerStart.y) >= 5) {
        state.pointerMoved = true;
      }
      panBy(pt.x - state.dragStart.x, pt.y - state.dragStart.y);
      state.dragStart = pt;
      event.preventDefault();
      return;
    }
    updateHoveredCandidateNode(pt);
    updateHoveredTaz(pt);
  });
  state.canvas.addEventListener("pointerup", finishPointer);
  state.canvas.addEventListener("pointercancel", finishPointer);
  state.canvas.addEventListener("pointerleave", () => {
    updateHoveredCandidateNode(null);
    updateHoveredTaz(null);
  });
}

function updateHoveredCandidateNode(pt) {
  const hit = state.missingLinkMode && pt
    ? findNodeAt(pt, 18)
    : state.selected && pt
      ? findEditableNodeAt(pt, 18)
      : null;
  const nextId = hit ? String(hit.id) : null;
  if (nextId === state.hoveredNodeId) return;
  state.hoveredNodeId = nextId;
  state.hoveredNode = hit;
  scheduleDraw();
}

function updateHoveredTaz(pt) {
  if (!state.data || !state.payload) return;
  const hit = pt ? findTazAt(pt) : null;
  const nextId = hit && String(hit.id) !== String(state.payload?.tazId) ? String(hit.id) : null;
  if (nextId === state.hoveredTazId) return;
  state.hoveredTazId = nextId;
  state.canvas.classList.toggle("taz-hover", Boolean(nextId));
  updateMapLibreSelection();
  scheduleDraw();
}

function finishPointer(event) {
  if (event.pointerType === "touch") {
    state.touchPointers.delete(event.pointerId);
    if (state.pinchGesture) {
      state.pinchGesture = state.touchPointers.size >= 2 ? touchPairMetrics() : null;
      state.activePointerId = state.touchPointers.size === 1 ? state.touchPointers.keys().next().value : null;
      state.isDraggingEndpoint = false;
      state.isPanning = false;
      state.dragStart = null;
      state.pointerStart = null;
      state.pointerMoved = false;
      state.clearSelectionOnPointerUp = false;
      state.canvas.classList.remove("dragging", "panning");
      finishCanvasPreview();
      scheduleViewportLoad();
      if (event.pointerId !== undefined && state.canvas.hasPointerCapture(event.pointerId)) state.canvas.releasePointerCapture(event.pointerId);
      return;
    }
  }
  if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;
  const shouldClearSelection = event.type === "pointerup"
    && state.clearSelectionOnPointerUp
    && !state.pointerMoved
    && !state.isDraggingEndpoint;
  if (state.isDraggingEndpoint) {
    if (state.pendingNode) {
      applyEditToNode(state.pendingNode);
    } else {
      toast("No editable node near endpoint.");
    }
    updateInspector();
  }
  state.isDraggingEndpoint = false;
  state.isPanning = false;
  state.dragStart = null;
  state.pointerStart = null;
  state.pointerMoved = false;
  state.clearSelectionOnPointerUp = false;
  state.activePointerId = null;
  state.canvas.classList.remove("dragging", "panning");
  if (event.pointerId !== undefined && state.canvas.hasPointerCapture(event.pointerId)) {
    state.canvas.releasePointerCapture(event.pointerId);
  }
  if (shouldClearSelection) clearSelection();
  finishCanvasPreview();
  scheduleViewportLoad();
}

function eventPoint(event) {
  const rect = state.canvas.parentElement.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function updateCanvasPreviewTransform() {
  const preview = state.canvasPreview;
  const transform = `matrix(${preview.scale}, 0, 0, ${preview.scale}, ${preview.x}, ${preview.y})`;
  state.canvas.style.transform = transform;
}

function previewCanvasPan(dx, dy) {
  state.canvasPreviewActive = true;
  state.canvasPreview.x += dx;
  state.canvasPreview.y += dy;
  updateCanvasPreviewTransform();
}

function previewCanvasZoom(x, y, scale) {
  state.canvasPreviewActive = true;
  state.canvasPreview.x = x + scale * (state.canvasPreview.x - x);
  state.canvasPreview.y = y + scale * (state.canvasPreview.y - y);
  state.canvasPreview.scale *= scale;
  updateCanvasPreviewTransform();
}

function finishCanvasPreview(delay = 0) {
  clearTimeout(state.interactionDrawTimer);
  const finish = () => {
    state.interactionDrawTimer = null;
    state.canvasPreviewActive = false;
    state.canvasPreview = { scale: 1, x: 0, y: 0 };
    state.canvas.style.transform = "none";
    draw();
  };
  if (delay > 0) state.interactionDrawTimer = setTimeout(finish, delay);
  else finish();
}

function touchPairMetrics() {
  const points = Array.from(state.touchPointers.values()).slice(0, 2);
  if (points.length < 2) return null;
  return {
    center: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
    distance: Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)),
  };
}

function beginPinchGesture() {
  state.pinchGesture = touchPairMetrics();
  state.isDraggingEndpoint = false;
  state.isPanning = false;
  state.dragStart = null;
  state.pointerStart = null;
  state.pointerMoved = true;
  state.lastTapAt = 0;
  state.canvas.classList.remove("dragging", "panning");
}

function updatePinchGesture() {
  const previous = state.pinchGesture;
  const current = touchPairMetrics();
  if (!previous || !current) return;
  panBy(current.center.x - previous.center.x, current.center.y - previous.center.y);
  const factor = Math.max(0.5, Math.min(2, previous.distance / current.distance));
  zoomAt(current.center.x, current.center.y, factor);
  state.pinchGesture = current;
}

function resizeCanvas() {
  const rect = state.canvas.parentElement.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  state.width = Math.max(120, Math.floor(rect.width));
  state.height = Math.max(120, Math.floor(rect.height));
  state.canvas.width = Math.floor(state.width * scale);
  state.canvas.height = Math.floor(state.height * scale);
  state.canvas.style.width = `${state.width}px`;
  state.canvas.style.height = `${state.height}px`;
  state.ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

function hasUserChanges(tazId) {
  const edit = state.edits[String(tazId)] || {};
  return Boolean(
    Object.keys(edit.connectors || {}).length
    || edit.added?.length
    || edit.deleted?.length
    || Object.prototype.hasOwnProperty.call(edit, "note")
  );
}

function importedCcDiffers(tazId) {
  if (!state.importedCc) return false;
  const clean = (value) => CcFileLoader.cleanId(value);
  const baseline = (state.connectorsByTaz.get(String(tazId)) || []).map((row) => clean(row.nodeId)).sort();
  const imported = (state.importedCc.get(String(tazId)) || []).map((row) => clean(row.nodeId)).sort();
  return baseline.length !== imported.length || baseline.some((nodeId, index) => nodeId !== imported[index]);
}

function getTazStatus(tazId) {
  const id = String(tazId);
  if ((state.connectorCountsByTaz.get(id) || 0) === 0) return "FLAG";
  const edit = state.edits[id] || {};
  const explicit = String(edit.qcStatus || "").toUpperCase();
  if (TAZ_STATUSES.includes(explicit)) return explicit;
  if (edit.reviewed) return "REVIEWED";
  if (hasUserChanges(tazId) || importedCcDiffers(tazId)) return "EDITED";
  if (state.newTazIds.has(id)) return "REVIEWED";
  return "WAITING FOR QC";
}

function markTazEdited(tazId) {
  const id = String(tazId);
  state.edits[id] ||= {};
  state.edits[id].qcStatus = "EDITED";
  delete state.edits[id].reviewed;
}

function setTazStatus(tazId, qcStatus) {
  const id = String(tazId || "");
  const normalized = String(qcStatus || "").toUpperCase();
  if (!id || !TAZ_STATUSES.includes(normalized)) return;
  pushEditHistory();
  state.edits[id] ||= {};
  state.edits[id].qcStatus = normalized;
  delete state.edits[id].reviewed;
  hideTazStatusMenu();
  saveLocal();
  toast(`TAZ ${id} status set to ${normalized}.`);
}

function sortTazOrder(items) {
  return [...items].sort((left, right) => {
    const leftNumber = Number(left.id);
    const rightNumber = Number(right.id);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
    return String(left.id).localeCompare(String(right.id), undefined, { numeric: true, sensitivity: "base" });
  });
}

function updateTazStatusSummary() {
  const counts = Object.fromEntries(TAZ_STATUSES.map((value) => [value, 0]));
  const scopedOrder = activeReviewTazOrder();
  for (const item of scopedOrder) {
    const value = getTazStatus(item.id);
    counts[value] = (counts[value] || 0) + 1;
  }
  const total = scopedOrder.length;
  const reviewed = counts.REVIEWED || 0;
  const reviewedPercent = total ? Math.round((reviewed / total) * 100) : 0;
  qs("statusReviewedCount").textContent = reviewed.toLocaleString();
  qs("statusEditedCount").textContent = (counts.EDITED || 0).toLocaleString();
  qs("statusFlagCount").textContent = (counts.FLAG || 0).toLocaleString();
  qs("statusWaitingCount").textContent = (counts["WAITING FOR QC"] || 0).toLocaleString();
  qs("statusTotalCount").textContent = total.toLocaleString();
  qs("statusReviewedPercent").textContent = `${reviewedPercent}% reviewed`;
  qs("statusReviewedProgress").style.width = `${reviewedPercent}%`;
}

function queueItemMatchesFilter(item, filter) {
  if (filter === "all") return true;
  if (filter === "cross-taz-shared-node") {
    return state.crossTazConflictTazIds.has(String(item.id));
  }
  if (filter === "changed-607") {
    return state.changed607TazIds.has(String(item.id));
  }
  if (filter === "auto-fixed-shared") {
    return state.autoFixedSharedTazIds.has(String(item.id));
  }
  return getTazStatus(item.id).toLowerCase() === filter;
}

function filteredReviewTazOrder(filter = qs("queueFilter")?.value || "all") {
  return activeReviewTazOrder().filter((item) => queueItemMatchesFilter(item, filter));
}

function isDedicatedReviewFilter(filter) {
  return filter === "cross-taz-shared-node"
    || filter === "changed-607"
    || filter === "auto-fixed-shared";
}

function renderQueue({ revealCurrent = false } = {}) {
  const list = qs("queueList");
  const currentId = String(state.payload?.tazId ?? "");
  const filterSelect = qs("queueFilter");
  if (revealCurrent && currentId && !isDedicatedReviewFilter(filterSelect.value)) {
    filterSelect.value = "all";
  }
  const filter = filterSelect.value;
  list.innerHTML = "";
  let activeRow = null;
  const fragment = document.createDocumentFragment();
  const visibleItems = filteredReviewTazOrder(filter);
  qs("tazListCount").textContent = filter === "cross-taz-shared-node"
    ? `${visibleItems.length} shown / ${state.crossTazConflictTazIds.size} affected${state.crossTazConflictFilterReady ? "" : " (refresh needed)"}`
    : filter === "changed-607"
      ? `${visibleItems.length} shown / ${state.changed607TazIds.size} review TAZs`
      : filter === "auto-fixed-shared"
        ? `${visibleItems.length} shown / ${state.autoFixedSharedTazIds.size} auto-fixed TAZs`
      : `${visibleItems.length} shown`;
  updateTazStatusSummary();
  visibleItems.forEach((item) => {
      const connectorCount = state.connectorCountsByTaz.get(String(item.id)) || 0;
      const row = document.createElement("div");
      const isCurrent = String(item.id) === currentId;
      row.className = `queue-item ${isCurrent ? "active" : ""}`;
      row.dataset.tazId = String(item.id);
      if (isCurrent) activeRow = row;
      const qcStatus = getTazStatus(item.id);
      const statusClass = qcStatus.toLowerCase().replace(/\s+/g, "-");
      const sharedNodes = state.crossTazConflictNodesByTaz.get(String(item.id)) || [];
      const issue = filter === "cross-taz-shared-node"
        ? `${sharedNodes.length} shared node${sharedNodes.length === 1 ? "" : "s"}: ${sharedNodes.slice(0, 4).join(", ")}${sharedNodes.length > 4 ? ", ..." : ""}`
        : filter === "changed-607"
          ? "Changed 2020-2025; New TAZ excluded"
          : filter === "auto-fixed-shared"
            ? "Cross-TAZ shared node auto-fixed; review new endpoint"
          : item.issue || "No issue noted";
      row.innerHTML = `<div><strong>${item.id}</strong><br><small>${issue} | ${connectorCount} CC</small></div><span class="pill ${statusClass}">${qcStatus}</span>`;
      fragment.appendChild(row);
    });
  list.appendChild(fragment);
  if (revealCurrent && activeRow) activeRow.scrollIntoView({ block: "nearest", inline: "nearest" });
  renderInspectorTables(true);
}

const SPATIAL_GRID_SIZE = 10000;

function gridCell(value) {
  return Math.floor(value / SPATIAL_GRID_SIZE);
}

function addToSpatialGrid(grid, item, bounds) {
  if (!bounds || ![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every(Number.isFinite)) return;
  for (let x = gridCell(bounds.minX); x <= gridCell(bounds.maxX); x += 1) {
    for (let y = gridCell(bounds.minY); y <= gridCell(bounds.maxY); y += 1) {
      const key = `${x},${y}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(item);
    }
  }
}

function addLineToSpatialGrid(index, minX, minY, maxX, maxY) {
  for (let x = gridCell(minX); x <= gridCell(maxX); x += 1) {
    for (let y = gridCell(minY); y <= gridCell(maxY); y += 1) {
      const key = `${x},${y}`;
      if (!state.linkGrid.has(key)) state.linkGrid.set(key, []);
      state.linkGrid.get(key).push(index);
    }
  }
}

function querySpatialGrid(grid, bounds) {
  const found = new Set();
  for (let x = gridCell(bounds.minX); x <= gridCell(bounds.maxX); x += 1) {
    for (let y = gridCell(bounds.minY); y <= gridCell(bounds.maxY); y += 1) {
      for (const item of grid.get(`${x},${y}`) || []) found.add(item);
    }
  }
  return Array.from(found);
}

function boundsIntersect(a, b) {
  return a && b && a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function linkBoundsIntersect(index, bounds) {
  const offset = index * 4;
  return state.gstdmLineBounds[offset] <= bounds.maxX
    && state.gstdmLineBounds[offset + 2] >= bounds.minX
    && state.gstdmLineBounds[offset + 1] <= bounds.maxY
    && state.gstdmLineBounds[offset + 3] >= bounds.minY;
}

function buildDataIndexes() {
  for (const taz of state.data.tazs) taz._bounds = geomBounds(taz.geom);
  state.tazById = new Map(state.data.tazs.map((item) => [String(item.id), item]));
  state.centroidById = new Map(state.data.centroids.map((item) => [String(item.id), item]));
  state.connectorsByTaz = new Map();
  for (const connector of state.data.connectors) {
    const id = String(connector.tazId);
    if (!state.connectorsByTaz.has(id)) state.connectorsByTaz.set(id, []);
    state.connectorsByTaz.get(id).push(connector);
  }
  state.newConnectorsByTaz = new Map();
  for (const connector of state.newData?.connectors || []) {
    const id = String(connector.tazId);
    if (!state.newConnectorsByTaz.has(id)) state.newConnectorsByTaz.set(id, []);
    state.newConnectorsByTaz.get(id).push(connector);
  }
  state.connectorNodes = state.data.connectorNodes || [];
  state.dataIndexesReady = true;
  rebuildViewportSpatialIndexes([], []);
}

function rebuildViewportSpatialIndexes(viewportNodes, gstdmLines) {
  state.viewportNodes = viewportNodes;
  const nodesById = new Map();
  for (const node of state.connectorNodes) nodesById.set(CcFileLoader.cleanId(node.id), node);
  for (const node of state.pinnedNodes.values()) nodesById.set(CcFileLoader.cleanId(node.id), node);
  for (const node of viewportNodes) nodesById.set(CcFileLoader.cleanId(node.id), node);
  state.nodeById = nodesById;
  state.nodeGrid = new Map();
  for (const node of nodesById.values()) {
    addToSpatialGrid(state.nodeGrid, node, { minX: node.x, maxX: node.x, minY: node.y, maxY: node.y });
  }
  state.linkGrid = new Map();
  state.gstdmLines = gstdmLines;
  state.gstdmLineBounds = new Float64Array(state.gstdmLines.length * 4);
  state.gstdmLines.forEach((coordinates, index) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const coordinate of coordinates) {
      minX = Math.min(minX, coordinate[0]);
      minY = Math.min(minY, coordinate[1]);
      maxX = Math.max(maxX, coordinate[0]);
      maxY = Math.max(maxY, coordinate[1]);
    }
    const offset = index * 4;
    state.gstdmLineBounds.set([minX, minY, maxX, maxY], offset);
    addLineToSpatialGrid(index, minX, minY, maxX, maxY);
  });
  state.gstdmCacheCanvas = document.createElement("canvas");
  state.gstdmCacheKey = "";
}

function viewportMode() {
  const scale = mapFrame().scale;
  if (scale < Number(state.tileManifest.overviewScale || 0.0012)) return "overview";
  if (scale < Number(state.tileManifest.detailScale || 0.006)) return "cluster";
  return "detail";
}

function paddedViewportBounds() {
  const bounds = visibleWorldBounds();
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const padding = Math.max(Number(state.tileManifest.paddingFeet || 0), span * 0.25);
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

function tileKeysForBounds(bounds) {
  const size = Number(state.tileManifest.tileSizeFeet);
  const keys = [];
  for (let column = Math.floor(bounds.minX / size); column <= Math.floor(bounds.maxX / size); column += 1) {
    for (let row = Math.floor(bounds.minY / size); row <= Math.floor(bounds.maxY / size); row += 1) {
      const key = `${column}_${row}`;
      if (state.tileManifest.tiles[key]) keys.push(key);
    }
  }
  return keys;
}

function fetchCached(cacheKey, url) {
  if (state.viewportCache.has(cacheKey)) return state.viewportCache.get(cacheKey);
  const request = fetchJson(url).catch((error) => {
    state.viewportCache.delete(cacheKey);
    throw error;
  });
  state.viewportCache.set(cacheKey, request);
  return request;
}

async function loadOverviewData() {
  if (!state.overviewData) {
    state.overviewData = await fetchCached("overview", state.tileManifest.overview);
  }
  return state.overviewData;
}

async function ensureNodesByIds(nodeIds) {
  const requestedIds = new Set(Array.from(nodeIds || [], CcFileLoader.cleanId).filter(Boolean));
  const missingIds = Array.from(requestedIds).filter((nodeId) => !state.nodeById.has(nodeId));
  if (!missingIds.length) return;
  if (!state.nodeIndex) state.nodeIndex = await fetchCached("node-index", state.tileManifest.nodeIndex);
  const keys = Array.from(new Set(missingIds.map((nodeId) => state.nodeIndex[nodeId]).filter(Boolean)));
  const tiles = await Promise.all(keys.map((key) => fetchCached(`nodes:${key}`, `data/tiles/nodes/${key}.json`)));
  for (const tile of tiles) {
    for (const node of tile.nodes || []) {
      const nodeId = CcFileLoader.cleanId(node.id);
      if (requestedIds.has(nodeId)) state.pinnedNodes.set(nodeId, node);
    }
  }
  rebuildViewportSpatialIndexes(state.viewportNodes, state.gstdmLines);
}

async function ensureImportedNodes(byTaz) {
  return ensureNodesByIds(
    Object.values(byTaz || {}).flatMap((rows) => rows.map((row) => row.nodeId))
  );
}

function syncPayloadSpatialData() {
  if (!state.payload) return;
  const spatial = basePayloadForTaz(state.payload.tazId);
  if (!spatial) return;
  state.payload.nodes = spatial.nodes;
  state.payload.links = spatial.links;
}

async function loadViewportFeatures() {
  if (!state.view || !state.maplibreLoaded) return;
  clearTimeout(state.viewportLoadTimer);
  state.viewportLoadTimer = null;
  state.viewportRequestId += 1;
  await ensureGlobalReviewChunksForBounds(mapViewportSourceBounds());
  state.viewportMode = state.maplibreMap.getZoom() >= 11.5 ? "detail" : "overview";
  state.activeTileKeys = [];
  state.activeClusters = [];
  rebuildViewportSpatialIndexes([], []);
  syncPayloadSpatialData();
  scheduleDraw();
}

function scheduleViewportLoad(delay = 220) {
  clearTimeout(state.viewportLoadTimer);
  state.viewportLoadTimer = setTimeout(() => void loadViewportFeatures(), delay);
}

function basePayloadForTaz(id, includeContext = true) {
  const tazId = String(id);
  const taz = state.tazById.get(tazId);
  const centroid = state.centroidById.get(tazId);
  if (!taz || !centroid) return null;
  let nodes = [];
  let links = [];
  if (includeContext) {
    const context = geomBounds(taz.geom);
    const padding = Number(state.data.contextFeet || 7920);
    context.minX -= padding;
    context.maxX += padding;
    context.minY -= padding;
    context.maxY += padding;
    nodes = querySpatialGrid(state.nodeGrid, context).filter((node) => node.x >= context.minX && node.x <= context.maxX && node.y >= context.minY && node.y <= context.maxY);
    links = querySpatialGrid(state.linkGrid, context).filter((index) => linkBoundsIntersect(index, context));
  }
  return {
    tazId,
    flag: taz.flag,
    issue: taz.issue,
    selected: taz.selected,
    target: taz.target,
    minimum: taz.minimum,
    taz: taz.geom,
    centroid: [centroid.x, centroid.y],
    connectors: structuredClone(state.connectorsByTaz.get(tazId) || []),
    nodes,
    links,
  };
}

function rebuildGlobalConnectorIndex() {
  if (!state.data) return;
  const connectors = [];
  state.connectorCountsByTaz = new Map(state.tazOrder.map((item) => {
    const tazId = String(item.id);
    const edit = state.edits[tazId] || {};
    const baseline = state.importedCc
      ? (state.importedCc.get(tazId) || []).length
      : Number(item.connectors || 0);
    const count = state.importedCc
      ? baseline
      : Math.max(0, baseline - (edit.deleted?.length || 0) + (edit.added?.length || 0));
    return [tazId, count];
  }));
  for (const taz of state.data.tazs) {
    const item = { id: taz.id };
    const payload = basePayloadForTaz(item.id, false);
    if (!payload) continue;
    applyImportedCc(payload);
    applySavedEdits(payload);
    state.connectorCountsByTaz.set(
      String(payload.tazId),
      payload.connectors.length + (payload.importUnavailableRows?.length || 0)
    );
    for (const connector of payload.connectors) connectors.push({ ...connector, tazId: payload.tazId });
  }
  state.globalConnectors = connectors;
  state.connectorGrid = new Map();
  for (const connector of connectors) {
    connector._bounds = geomBounds(connector.geom);
    addToSpatialGrid(state.connectorGrid, connector, connector._bounds);
  }
  refreshMapLibreConnectors();
}

async function goToTaz(id, keepView = false) {
  const requestedId = String(id ?? "").trim();
  const index = state.tazOrder.findIndex((item) => String(item.id) === requestedId);
  if (index < 0) {
    const numericId = Number(requestedId);
    const numericTazIds = state.tazOrder
      .map((item) => Number(item.id))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    const previous = Number.isFinite(numericId)
      ? numericTazIds.filter((value) => value < numericId).at(-1)
      : null;
    const next = Number.isFinite(numericId)
      ? numericTazIds.find((value) => value > numericId)
      : null;
    const nearby = [previous, next].filter((value) => value != null).join(" / ");
    const message = `TAZ ${requestedId || "(blank)"} not found${nearby ? `. Nearest available: ${nearby}.` : "."}`;
    qs("jumpInput").setAttribute("aria-invalid", "true");
    status(message);
    toast(message);
    return false;
  }
  qs("jumpInput").removeAttribute("aria-invalid");
  if (state.dirty && !confirm("Current edit is not saved. Continue?")) return;
  const item = state.tazOrder[index];
  const targetChunk = state.globalReviewChunkByTaz.get(String(item.id));
  if (targetChunk && targetChunk !== state.activeGlobalReviewChunk) {
    await activateGlobalReviewChunk(targetChunk, false);
  } else {
    await ensureGlobalReviewChunkForTaz(id);
  }
  state.currentIndex = activeReviewTazOrder().findIndex(
    (activeItem) => String(activeItem.id) === String(item.id)
  );
  state.payload = basePayloadForTaz(item.id);
  applyImportedCc(state.payload);
  applySavedEdits(state.payload);
  state.selected = null;
  state.selectedMissingLink = null;
  state.pendingNode = null;
  state.dirty = false;
  state.hoveredTazId = null;
  state.canvas.classList.remove("taz-hover");
  state.inspectorNoteKey = null;
  qs("jumpInput").value = item.id;
  updateMapLibreSelection();
  if (!keepView) setViewToPayload();
  refreshMapLibreViewportSources();
  await loadViewportFeatures();
  state.payload = basePayloadForTaz(item.id);
  applyImportedCc(state.payload);
  applySavedEdits(state.payload);
  renderQueue({ revealCurrent: true });
  updateInspector();
  updateMapLibreSelection();
  draw();
  const unavailable = state.payload.importUnavailableRows?.length || 0;
  const importWarning = unavailable ? `; ${unavailable} uploaded CC(s) reference nodes outside this page context` : "";
  status(`TAZ ${item.id}: ${state.payload.connectors.length} connector(s) | MapLibre MVT network ready${importWarning}`);
  return true;
}

function applyImportedCc(payload) {
  if (!state.importedCc) return;
  const rows = state.importedCc.get(String(payload.tazId)) || [];
  payload.importUnavailableRows = [];
  payload.connectors = rows.flatMap((row, index) => {
    const node = state.nodeById.get(CcFileLoader.cleanId(row.nodeId));
    let geometry = row.geometry;
    if (geometry?.type === "MultiLineString") geometry = { type: "LineString", coordinates: geometry.coordinates[0] || [] };
    if (node) {
      geometry = { type: "LineString", coordinates: [payload.centroid, [node.x, node.y]] };
    } else if (!geometry || geometry.type !== "LineString") {
      payload.importUnavailableRows.push(row);
      return [];
    }
    const endpoint = geometry.coordinates[geometry.coordinates.length - 1];
    const endBoundaryDist = endpoint ? pointGeometryBoundaryDistance(endpoint, payload.taz) : null;
    const outsideLen = endpoint ? segmentOutsideLength(payload.centroid, endpoint, payload.taz) : null;
    return [{
      ccPt: row.ccPt || `${payload.tazId}_UPLOAD${index + 1}`,
      nodeId: row.nodeId,
      majorLevel: node?.majorLevel ?? null,
      outsideLen,
      endBoundaryDist,
      interiorFallback: endBoundaryDist != null ? endBoundaryDist > 200.000001 : false,
      lineNodeDist: 0,
      status: "uploaded",
      geom: geometry,
    }];
  });
}

function restoreImportedCc() {
  try {
    const saved = readStoredJson(STORAGE_KEYS.importedCc, null);
    if (!saved?.byTaz || typeof saved.byTaz !== "object") return;
    state.importedCc = new Map(Object.entries(saved.byTaz));
    state.importedSource = String(saved.source || "Uploaded CC file");
  } catch (error) {
    console.warn("Could not restore uploaded CC baseline", error);
    localStorage.removeItem(STORAGE_KEYS.importedCc);
  }
}

function updateImportedCcUi() {
  qs("tazStat").textContent = state.index.count ?? state.data.tazs.length;
  if (!state.importedCc) {
    qs("uploadBadge").classList.add("hidden");
    qs("resetCcBtn").classList.add("hidden");
    qs("runFolder").textContent = state.index.dataset || state.index.generatedFrom;
    qs("ccStat").textContent = state.index.counts?.connectors ?? state.data.connectors.length;
    return;
  }
  const count = Array.from(state.importedCc.values()).reduce((sum, rows) => sum + rows.length, 0);
  qs("uploadBadge").textContent = `${count} uploaded CC`;
  qs("uploadBadge").title = state.importedSource;
  qs("uploadBadge").classList.remove("hidden");
  qs("resetCcBtn").classList.remove("hidden");
  qs("runFolder").textContent = state.importedSource;
  qs("ccStat").textContent = count;
}

function compactImportedGeometry(geometry) {
  const coordinates = geometry?.type === "LineString"
    ? geometry.coordinates
    : geometry?.type === "MultiLineString"
      ? geometry.coordinates?.[0]
      : null;
  if (!coordinates?.length) return null;
  return { type: "LineString", coordinates: [coordinates[0], coordinates[coordinates.length - 1]] };
}

async function importCcFiles(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;
  try {
    if (Object.keys(state.edits || {}).length && !confirm("Loading a new CC file replaces the current CC baseline and clears browser-saved QC edits. Continue?")) return;
    const result = await CcFileLoader.loadFiles(files, state.tazOrder.map((item) => item.id));
    await ensureImportedNodes(result.byTaz);
    const compactByTaz = Object.fromEntries(Object.entries(result.byTaz).map(([tazId, rows]) => [
      tazId,
      rows.map(({ nodeId, ccPt, geometry }) => ({ nodeId, ccPt, geometry: compactImportedGeometry(geometry) })),
    ]));
    state.importedCc = new Map(Object.entries(compactByTaz));
    state.importedSource = result.sourceNames.join(", ");
    state.edits = {};
    state.crossTazConflictFilterReady = false;
    state.undoStack = [];
    state.redoStack = [];
    localStorage.removeItem(STORAGE_KEYS.edits);
    localStorage.setItem(STORAGE_KEYS.importedCc, JSON.stringify({ source: state.importedSource, byTaz: compactByTaz }));
    rebuildGlobalConnectorIndex();
    updateImportedCcUi();
    updateHistoryButtons();
    renderQueue();
    await goToTaz(state.payload?.tazId || state.tazOrder[0].id);
    const details = [];
    if (result.duplicates) details.push(`${result.duplicates} reverse/duplicate rows removed`);
    if (result.ignored) details.push(`${result.ignored} unrecognized rows ignored`);
    toast(`Loaded ${result.connectorCount} CCs${details.length ? `; ${details.join("; ")}` : ""}.`);
  } catch (error) {
    console.error(error);
    toast(error.message);
    status(`CC import failed: ${error.message}`);
  }
}

async function resetImportedCc() {
  if (Object.keys(state.edits || {}).length && !confirm("Restoring the default CC data also clears edits made against the uploaded file. Continue?")) return;
  state.importedCc = null;
  state.importedSource = "";
  state.edits = {};
  state.crossTazConflictFilterReady = false;
  state.undoStack = [];
  state.redoStack = [];
  localStorage.removeItem(STORAGE_KEYS.importedCc);
  localStorage.removeItem(STORAGE_KEYS.edits);
  rebuildGlobalConnectorIndex();
  updateImportedCcUi();
  updateHistoryButtons();
  renderQueue();
  await goToTaz(state.payload?.tazId || state.tazOrder[0].id);
  toast("Default CC data restored.");
}

function resetBrowserData() {
  const confirmed = confirm(
    "Reset the Global TAZ / Global CC review data to its published defaults? This permanently deletes browser-saved Global CC edits, added or imported HERE_MISS changes, Global TAZ QC notes and reviewed status, uploaded Global CC data, and the Global layer order. Saved work for the previous New TAZ / New CC dataset is preserved. Export anything you need first."
  );
  if (!confirmed) return;
  Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
  window.location.reload();
}

function shiftTaz(delta) {
  const scopedOrder = filteredReviewTazOrder();
  if (!scopedOrder.length) return;
  const currentIndex = scopedOrder.findIndex(
    (item) => String(item.id) === String(state.payload?.tazId)
  );
  const next = Math.max(
    0,
    Math.min(scopedOrder.length - 1, Math.max(0, currentIndex) + delta)
  );
  goToTaz(scopedOrder[next].id);
}

function applySavedEdits(payload) {
  const saved = state.edits[payload.tazId];
  if (!saved) return;
  const deleted = new Set(saved.deleted || []);
  payload.connectors = payload.connectors.filter((connector) => !deleted.has(connector.ccPt));
  for (const connector of payload.connectors) {
    const edit = saved.connectors?.[connector.ccPt];
    if (edit) Object.assign(connector, edit);
  }
  if (saved.added) payload.connectors.push(...saved.added);
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEYS.edits, JSON.stringify(state.edits));
  state.crossTazConflictFilterReady = false;
  rebuildGlobalConnectorIndex();
  updateHistoryButtons();
  renderQueue();
}

function editSnapshot() {
  return JSON.stringify({ edits: state.edits || {}, missingLinks: state.missingLinks || [] });
}

function pushEditHistory() {
  state.undoStack.push(editSnapshot());
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undo = qs("undoBtn");
  const redo = qs("redoBtn");
  if (!undo || !redo) return;
  undo.disabled = state.undoStack.length === 0;
  redo.disabled = state.redoStack.length === 0;
}

async function restoreEdits(snapshot) {
  const restored = JSON.parse(snapshot || "{}");
  state.edits = Object.prototype.hasOwnProperty.call(restored, "edits") ? restored.edits || {} : restored;
  if (Object.prototype.hasOwnProperty.call(restored, "missingLinks")) {
    state.missingLinks = Array.isArray(restored.missingLinks) ? restored.missingLinks : [];
  }
  localStorage.setItem(STORAGE_KEYS.edits, JSON.stringify(state.edits));
  localStorage.setItem(STORAGE_KEYS.missingLinks, JSON.stringify(state.missingLinks));
  state.selected = null;
  state.selectedMissingLink = null;
  state.pendingNode = null;
  state.missingLinkStartNode = null;
  state.contextConnector = null;
  state.dirty = false;
  hideContextMenu();
  rebuildGlobalConnectorIndex();
  refreshMapLibreMissingLinks();
  updateMissingLinkModeUi();
  updateHistoryButtons();
  renderQueue();
  if (state.payload) await goToTaz(state.payload.tazId, true);
}

async function undoEdit() {
  if (!state.undoStack.length) {
    toast("No edit to undo.");
    return;
  }
  state.redoStack.push(editSnapshot());
  const snapshot = state.undoStack.pop();
  await restoreEdits(snapshot);
  toast("Edit undone.");
}

async function redoEdit() {
  if (!state.redoStack.length) {
    toast("No edit to redo.");
    return;
  }
  state.undoStack.push(editSnapshot());
  const snapshot = state.redoStack.pop();
  await restoreEdits(snapshot);
  toast("Edit redone.");
}

function setViewToPayload() {
  const bounds = geomBounds(state.payload.taz);
  const pad = Math.max(500, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.12);
  state.view = { minX: bounds.minX - pad, maxX: bounds.maxX + pad, minY: bounds.minY - pad, maxY: bounds.maxY + pad };
  syncMapToView();
}

function setViewToAllData() {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const centroids = state.activeGlobalReviewChunk
    ? (state.data.centroids || []).filter(
        (centroid) => state.globalReviewChunkByTaz.get(String(centroid.id)) === state.activeGlobalReviewChunk
      )
    : (state.data.centroids || []);
  for (const centroid of centroids) {
    bounds.minX = Math.min(bounds.minX, centroid.x);
    bounds.maxX = Math.max(bounds.maxX, centroid.x);
    bounds.minY = Math.min(bounds.minY, centroid.y);
    bounds.maxY = Math.max(bounds.maxY, centroid.y);
  }
  const pad = Math.max(2000, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.03);
  state.view = { minX: bounds.minX - pad, maxX: bounds.maxX + pad, minY: bounds.minY - pad, maxY: bounds.maxY + pad };
  syncMapToView();
}

function showAllStatus() {
  const counts = state.data.counts || {};
  status(`Core loaded: ${counts.tazs || state.data.tazs.length} TAZs, ${counts.connectors || state.globalConnectors.length} CCs | viewport data loads on demand`);
}

function zoomAll() {
  setViewToAllData();
  draw();
  status("MapLibre statewide MVT overview ready.");
  scheduleViewportLoad(0);
}

function geomBounds(geom) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  walkCoords(geom.coordinates, (xy) => {
    b.minX = Math.min(b.minX, xy[0]);
    b.maxX = Math.max(b.maxX, xy[0]);
    b.minY = Math.min(b.minY, xy[1]);
    b.maxY = Math.max(b.maxY, xy[1]);
  });
  return b;
}

function walkCoords(coords, fn) {
  if (typeof coords[0] === "number") fn(coords);
  else coords.forEach((part) => walkCoords(part, fn));
}

function mapFrame() {
  if (state.maplibreLoaded) {
    const center = { x: state.width / 2, y: state.height / 2 };
    const first = unproject(center);
    const second = unproject({ x: center.x + 100, y: center.y });
    const distance = Math.hypot(second[0] - first[0], second[1] - first[1]);
    return { scale: distance > 0 ? 100 / distance : 1, offsetX: 0, offsetY: 0 };
  }
  const spanX = state.view.maxX - state.view.minX;
  const spanY = state.view.maxY - state.view.minY;
  const scale = Math.min(state.width / spanX, state.height / spanY);
  return { scale, offsetX: (state.width - spanX * scale) / 2, offsetY: (state.height - spanY * scale) / 2 };
}

function project(xy) {
  if (state.maplibreLoaded) {
    const point = state.maplibreMap.project(sourceToLonLat(xy));
    return { x: point.x, y: point.y };
  }
  const f = mapFrame();
  return { x: f.offsetX + (xy[0] - state.view.minX) * f.scale, y: f.offsetY + (state.view.maxY - xy[1]) * f.scale };
}

function unproject(pt) {
  if (state.maplibreLoaded) {
    const lngLat = state.maplibreMap.unproject([pt.x, pt.y]);
    return lonLatToSource([lngLat.lng, lngLat.lat]);
  }
  const f = mapFrame();
  return [state.view.minX + (pt.x - f.offsetX) / f.scale, state.view.maxY - (pt.y - f.offsetY) / f.scale];
}

function visibleWorldBounds() {
  const corners = [
    unproject({ x: 0, y: 0 }),
    unproject({ x: state.width, y: 0 }),
    unproject({ x: 0, y: state.height }),
    unproject({ x: state.width, y: state.height }),
  ];
  return {
    minX: Math.min(...corners.map((point) => point[0])),
    maxX: Math.max(...corners.map((point) => point[0])),
    minY: Math.min(...corners.map((point) => point[1])),
    maxY: Math.max(...corners.map((point) => point[1])),
  };
}

function zoomAt(x, y, factor) {
  if (!state.view) return;
  if (state.maplibreLoaded) {
    const around = state.maplibreMap.unproject([x, y]);
    state.maplibreMap.easeTo({ zoom: state.maplibreMap.getZoom() + Math.log2(1 / factor), around, duration: 0 });
    syncViewFromMapLibre();
    scheduleViewportLoad();
    return;
  }
  const before = unproject({ x, y });
  const width = (state.view.maxX - state.view.minX) * factor;
  const height = (state.view.maxY - state.view.minY) * factor;
  const f = mapFrame();
  const rx = Math.max(0, Math.min(1, (x - f.offsetX) / (state.width - f.offsetX * 2 || state.width)));
  const ry = Math.max(0, Math.min(1, (y - f.offsetY) / (state.height - f.offsetY * 2 || state.height)));
  state.view.minX = before[0] - width * rx;
  state.view.maxX = state.view.minX + width;
  state.view.maxY = before[1] + height * ry;
  state.view.minY = state.view.maxY - height;
  previewCanvasZoom(x, y, 1 / factor);
  finishCanvasPreview(90);
  scheduleViewportLoad();
}

function panBy(dx, dy) {
  if (state.maplibreLoaded) {
    state.maplibreMap.panBy([-dx, -dy], { duration: 0 });
    syncViewFromMapLibre();
    return;
  }
  const f = mapFrame();
  const mx = -dx / f.scale;
  const my = dy / f.scale;
  state.view.minX += mx;
  state.view.maxX += mx;
  state.view.minY += my;
  state.view.maxY += my;
  previewCanvasPan(dx, dy);
}

function scheduleDraw() {
  if (state.canvasPreviewActive) return;
  if (state.drawPending) return;
  state.drawPending = true;
  requestAnimationFrame(() => {
    state.drawPending = false;
    draw();
  });
}

function updateBasemapAttribution() {
  const attribution = qs("basemapAttribution");
  if (!attribution) return;
  attribution.classList.toggle("hidden", state.basemap === "none");
  attribution.innerHTML = state.basemap === "satellite"
    ? '<a href="https://www.esri.com/" target="_blank" rel="noopener">Tiles &copy; Esri</a>'
    : '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';
}

function draw(mousePoint = null) {
  const ctx = state.ctx;
  ctx.clearRect(0, 0, state.width, state.height);
  if (!state.payload || !state.view) return;
  if (state.missingLinkMode) drawMissingLinkEditor();
  if (state.selected && state.pendingNode) {
    const start = project(state.payload.centroid);
    const end = project([state.pendingNode.x, state.pendingNode.y]);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = "#ff8500";
    ctx.lineWidth = 5;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.restore();
    drawHighlightedCandidateNode(end, 8);
  }
  if (state.hoveredNode && !state.pendingNode && !state.missingLinkMode) {
    drawHighlightedCandidateNode(project([state.hoveredNode.x, state.hoveredNode.y]), 8);
  }
  drawEndpoint(mousePoint);
}

function drawMissingLinkEditor() {
  const start = state.missingLinkStartNode;
  const hovered = state.hoveredNode;
  const ctx = state.ctx;
  if (start && hovered && String(start.id) !== String(hovered.id)) {
    const startPoint = project([start.x, start.y]);
    const endPoint = project([hovered.x, hovered.y]);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(startPoint.x, startPoint.y);
    ctx.lineTo(endPoint.x, endPoint.y);
    ctx.strokeStyle = "#8a35c5";
    ctx.lineWidth = 5;
    ctx.setLineDash([10, 6]);
    ctx.stroke();
    ctx.restore();
  }
  if (start) drawMissingLinkNode(project([start.x, start.y]), "start");
  if (hovered) drawMissingLinkNode(project([hovered.x, hovered.y]), "hover");
}

function drawMissingLinkNode(point, kind) {
  const ctx = state.ctx;
  ctx.save();
  ctx.beginPath();
  ctx.arc(point.x, point.y, kind === "start" ? 11 : 10, 0, Math.PI * 2);
  ctx.fillStyle = kind === "start" ? "#2067d1" : "#b15cff";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = kind === "start" ? "#0a3675" : "#5d1a91";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

function drawAllTazPolygons(globalScale) {
  const fill = globalScale ? "rgba(55,125,215,0.09)" : "rgba(55,125,215,0.055)";
  const stroke = globalScale ? "rgba(22,91,177,0.88)" : "rgba(22,91,177,0.72)";
  const width = globalScale ? 2.25 : 2.75;
  const visible = visibleWorldBounds();
  for (const taz of state.data.tazs) {
    if (boundsIntersect(taz._bounds, visible)) drawGeometry(taz.geom, fill, stroke, width);
  }
}

async function importMissingLinkFiles(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;
  try {
    if (state.missingLinks.length && !confirm("Loading a HERE_MISS file replaces the current HERE_MISS layer. Continue?")) return;
    const result = await CcFileLoader.loadMissingLinkFiles(files);
    await ensureNodesByIds(result.links.flatMap((link) => [link.a, link.b]));
    let unavailable = 0;
    const loadedLinks = result.links.flatMap((link) => {
      const first = state.nodeById.get(CcFileLoader.cleanId(link.a));
      const second = state.nodeById.get(CcFileLoader.cleanId(link.b));
      if (!first || !second) {
        unavailable += 1;
        return [];
      }
      return [{
        pairKey: missingLinkPairKey(link.a, link.b),
        a: String(link.a),
        b: String(link.b),
        aCoord: [Number(first.x), Number(first.y)],
        bCoord: [Number(second.x), Number(second.y)],
        records: Math.max(1, Math.min(2, Number(link.records) || 2)),
        lanes: Number.isFinite(Number(link.lanes)) ? Number(link.lanes) : 1,
        hereMiss: Number.isFinite(Number(link.hereMiss)) ? Number(link.hereMiss) : MISSING_LINK_DEFAULTS.hereMiss,
        fclass: Number.isFinite(Number(link.fclass)) ? Number(link.fclass) : MISSING_LINK_DEFAULTS.fclass,
      }];
    });
    if (!loadedLinks.length) {
      throw new Error("No HERE_MISS links could be mapped because their A/B node IDs were not found in the published node index.");
    }
    pushEditHistory();
    stopMissingLinkMode();
    state.missingLinks = loadedLinks;
    state.selected = null;
    state.selectedMissingLink = loadedLinks[0];
    state.pendingNode = null;
    state.inspectorTab = "missing";
    state.layers.hereMiss = true;
    const layerToggle = document.querySelector('input[data-layer="hereMiss"]');
    if (layerToggle) layerToggle.checked = true;
    localStorage.setItem(STORAGE_KEYS.missingLinks, JSON.stringify(state.missingLinks));
    refreshMapLibreMissingLinks();
    syncMapLibreLayerState();
    updateMapLibreSelection();
    updateMissingLinkModeUi();
    updateHistoryButtons();
    renderInspectorTables(true);
    draw();
    const details = [];
    if (result.duplicates) details.push(`${result.duplicates} reverse/duplicate records combined`);
    if (result.ignored) details.push(`${result.ignored} invalid records ignored`);
    if (unavailable) details.push(`${unavailable} links referenced unknown nodes`);
    const detailText = details.length ? `; ${details.join("; ")}` : "";
    status(`Loaded ${loadedLinks.length} HERE_MISS links from ${result.sourceNames.join(", ")}${detailText}.`);
    toast(`Loaded ${loadedLinks.length} HERE_MISS links${detailText}.`);
  } catch (error) {
    console.error(error);
    toast(error.message);
    status(`HERE_MISS import failed: ${error.message}`);
  }
}

function drawTazLabels(globalScale) {
  const ctx = state.ctx;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const visible = visibleWorldBounds();
  for (const centroid of state.data.centroids) {
    const current = String(centroid.id) === String(state.payload.tazId);
    const hovered = String(centroid.id) === state.hoveredTazId;
    if (centroid.x < visible.minX || centroid.x > visible.maxX || centroid.y < visible.minY || centroid.y > visible.maxY) continue;
    const p = project([centroid.x, centroid.y]);
    if (p.x < -30 || p.x > state.width + 30 || p.y < -30 || p.y > state.height + 30) continue;
    ctx.font = current ? "700 24px Arial" : hovered ? "700 19px Arial" : globalScale ? "700 11px Arial" : "700 15px Arial";
    ctx.lineWidth = current ? 5 : hovered ? 4 : 3.5;
    ctx.strokeStyle = "rgba(255,255,255,0.96)";
    const labelY = p.y - (current ? 20 : 16);
    ctx.strokeText(String(centroid.id), p.x, labelY);
    ctx.fillStyle = current ? "#075fc7" : hovered ? "#d85d00" : "#143b70";
    ctx.fillText(String(centroid.id), p.x, labelY);
  }
  ctx.restore();
}

function sourceToLonLat(xy) {
  if (xy && typeof xy === "object") {
    const cached = state.sourceProjectionCache.get(xy);
    if (cached) return cached;
    const projected = proj4(SOURCE_PROJ, "WGS84", xy);
    state.sourceProjectionCache.set(xy, projected);
    return projected;
  }
  return proj4(SOURCE_PROJ, "WGS84", xy);
}

function lonLatToSource(xy) {
  return proj4("WGS84", SOURCE_PROJ, xy);
}

function drawGrid() {
  const ctx = state.ctx;
  ctx.strokeStyle = "#e5e9f0";
  ctx.lineWidth = 1;
  for (let x = 0; x < state.width; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, state.height);
    ctx.stroke();
  }
  for (let y = 0; y < state.height; y += 80) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(state.width, y);
    ctx.stroke();
  }
}

function drawGeometry(geom, fill, stroke, width) {
  const ctx = state.ctx;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  if (fill) ctx.fillStyle = fill;
  const type = geom.type;
  if (type === "Polygon") drawPolygon(geom.coordinates, Boolean(fill));
  if (type === "MultiPolygon") geom.coordinates.forEach((part) => drawPolygon(part, Boolean(fill)));
  if (type === "LineString") drawLine(geom.coordinates);
  if (type === "MultiLineString") geom.coordinates.forEach(drawLine);
  ctx.restore();
}

function drawPolygon(rings, fill) {
  const ctx = state.ctx;
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((xy, i) => {
      const p = project(xy);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
  }
  if (fill) ctx.fill("evenodd");
  ctx.stroke();
}

function drawLine(coords) {
  const ctx = state.ctx;
  ctx.beginPath();
  coords.forEach((xy, i) => {
    const p = project(xy);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}

function drawConnectors() {
  const bounds = visibleWorldBounds();
  const visible = querySpatialGrid(state.connectorGrid, bounds).filter((connector) => boundsIntersect(connector._bounds, bounds));
  for (const c of visible) {
    const selected = state.selected?.ccPt === c.ccPt;
    const currentTaz = String(c.tazId) === String(state.payload.tazId);
    const color = selected
      ? "#ff8500"
      : c.status === "edited" || c.status === "added"
        ? "#8a2be2"
        : currentTaz
          ? "#d62828"
          : "rgba(214,40,40,0.55)";
    drawGeometry(connectorGeom(c), null, color, selected ? 6 : 4);
  }
}

function drawNodes(kind) {
  if (state.viewportMode !== "detail") {
    if (kind === "nonmajor") drawNodeClusters();
    return;
  }
  const ctx = state.ctx;
  const bounds = visibleWorldBounds();
  const visible = querySpatialGrid(state.nodeGrid, bounds).filter((node) => {
    const inBounds = node.x >= bounds.minX && node.x <= bounds.maxX && node.y >= bounds.minY && node.y <= bounds.maxY;
    return inBounds && (kind === "major" ? !node.eligible : node.eligible);
  });
  const scale = mapFrame().scale;
  if (scale < 0.001) {
    for (const n of visible) {
      const p = project([n.x, n.y]);
      const hovered = Boolean(state.selected && n.eligible && String(n.id) === state.hoveredNodeId);
      if (hovered) {
        drawHighlightedCandidateNode(p, 9);
        continue;
      }
      ctx.fillStyle = n.eligible ? "rgba(42,168,118,0.4)" : "rgba(214,40,40,0.55)";
      ctx.fillRect(p.x - 0.6, p.y - 0.6, 1.2, 1.2);
    }
    return;
  }
  for (const n of visible) {
    const p = project([n.x, n.y]);
    if (p.x < -10 || p.x > state.width + 10 || p.y < -10 || p.y > state.height + 10) continue;
    const hovered = Boolean(state.selected && n.eligible && String(n.id) === state.hoveredNodeId);
    if (hovered) {
      drawHighlightedCandidateNode(p, 10);
      continue;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, n.eligible ? 4 : 5, 0, Math.PI * 2);
    ctx.fillStyle = n.eligible ? "#2aa876" : "#d62828";
    ctx.fill();
    if (state.pendingNode?.id === n.id) {
      ctx.strokeStyle = "#ff8500";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
}

function drawNodeClusters() {
  const ctx = state.ctx;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 10px Segoe UI, Arial";
  for (const cluster of state.activeClusters) {
    const point = project([cluster.x, cluster.y]);
    if (point.x < -20 || point.x > state.width + 20 || point.y < -20 || point.y > state.height + 20) continue;
    const radius = Math.max(4, Math.min(14, 3 + Math.log2(cluster.count + 1)));
    const eligibleRatio = cluster.count ? cluster.eligible / cluster.count : 0;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = eligibleRatio >= 0.5 ? "rgba(42,168,118,0.78)" : "rgba(214,40,40,0.76)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (radius >= 8) {
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(cluster.count), point.x, point.y);
    }
  }
  ctx.restore();
}

function drawHighlightedCandidateNode(point, radius) {
  const ctx = state.ctx;
  ctx.save();
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#2aa876";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.98)";
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.strokeStyle = "#ff8500";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

function drawCentroids() {
  const ctx = state.ctx;
  const bounds = visibleWorldBounds();
  for (const centroid of state.data.centroids) {
    if (centroid.x < bounds.minX || centroid.x > bounds.maxX || centroid.y < bounds.minY || centroid.y > bounds.maxY) continue;
    const current = String(centroid.id) === String(state.payload.tazId);
    const p = project([centroid.x, centroid.y]);
    drawCentroidTriangle(ctx, p, current ? 17 : 12);
  }
}

function drawCentroidTriangle(ctx, point, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(point.x, point.y - radius);
  ctx.lineTo(point.x + radius * 0.9, point.y + radius * 0.72);
  ctx.lineTo(point.x - radius * 0.9, point.y + radius * 0.72);
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.98)";
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.fillStyle = "#e00000";
  ctx.fill();
  ctx.strokeStyle = "#8b0000";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawGlobalLinks() {
  const bounds = visibleWorldBounds();
  const visible = querySpatialGrid(state.linkGrid, bounds).filter((index) => linkBoundsIntersect(index, bounds));
  const ctx = state.ctx;
  const scale = window.devicePixelRatio || 1;
  const cacheKey = [
    state.width,
    state.height,
    scale,
    state.view.minX,
    state.view.minY,
    state.view.maxX,
    state.view.maxY,
  ].join("|");
  if (state.gstdmCacheKey !== cacheKey) {
    const cache = state.gstdmCacheCanvas || document.createElement("canvas");
    state.gstdmCacheCanvas = cache;
    cache.width = Math.floor(state.width * scale);
    cache.height = Math.floor(state.height * scale);
    const cacheCtx = cache.getContext("2d");
    cacheCtx.setTransform(scale, 0, 0, scale, 0, 0);
    cacheCtx.clearRect(0, 0, state.width, state.height);
    cacheCtx.strokeStyle = "rgba(12,12,12,0.9)";
    cacheCtx.lineWidth = mapFrame().scale < 0.001 ? 1 : 2;
    const chunkSize = 4000;
    for (let start = 0; start < visible.length; start += chunkSize) {
      cacheCtx.beginPath();
      for (const index of visible.slice(start, start + chunkSize)) {
        traceLineCoordinates(state.gstdmLines[index], cacheCtx);
      }
      cacheCtx.stroke();
    }
    state.gstdmCacheKey = cacheKey;
  }
  ctx.save();
  ctx.drawImage(state.gstdmCacheCanvas, 0, 0, state.width, state.height);
  ctx.restore();
}

function traceLineCoordinates(coordinates, ctx = state.ctx) {
  coordinates.forEach((xy, index) => {
    const point = project(xy);
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
}

function traceLineGeometry(geometry, ctx = state.ctx) {
  if (!geometry) return;
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
  for (const coordinates of lines) traceLineCoordinates(coordinates, ctx);
}

function connectorGeom(c) {
  if (state.selected?.ccPt === c.ccPt && state.pendingNode) {
    return { type: "LineString", coordinates: [state.payload.centroid, [state.pendingNode.x, state.pendingNode.y]] };
  }
  return c.geom;
}

function endpointCoord(c) {
  const geom = connectorGeom(c);
  return geom.coordinates[geom.coordinates.length - 1];
}

function drawEndpoint(mousePoint) {
  if (!state.selected) return;
  const p = mousePoint || project(endpointCoord(state.selected));
  const ctx = state.ctx;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
  ctx.strokeStyle = "#ff8500";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function findConnectorAt(pt) {
  let best = null;
  let bestDist = 10;
  for (const c of state.payload.connectors) {
    const coords = connectorGeom(c).coordinates;
    for (let i = 1; i < coords.length; i++) {
      const d = pointSegmentDistance(pt, project(coords[i - 1]), project(coords[i]));
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
  }
  return best;
}

function findMissingLinkAt(pt) {
  if (!state.layers.hereMiss) return null;
  let best = null;
  let bestDistance = 11;
  for (const link of state.missingLinks) {
    if (!Array.isArray(link.aCoord) || !Array.isArray(link.bCoord)) continue;
    const distance = pointSegmentDistance(pt, project(link.aCoord), project(link.bCoord));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = link;
    }
  }
  return best;
}

function findNodeAt(pt, hitRadius = 13) {
  const rendered = renderedNodeAt(pt, hitRadius, false);
  if (rendered) return rendered;
  let best = null;
  let bestDist = hitRadius;
  for (const n of state.payload.nodes) {
    const p = project([n.x, n.y]);
    const d = Math.hypot(pt.x - p.x, pt.y - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

function findEditableNodeAt(pt, hitRadius = 18) {
  const rendered = renderedNodeAt(pt, hitRadius, false);
  if (rendered) return rendered;
  let best = null;
  let bestDist = hitRadius;
  for (const n of state.payload.nodes) {
    const p = project([n.x, n.y]);
    const d = Math.hypot(pt.x - p.x, pt.y - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

function nearestEditableNode(pt) {
  const rendered = renderedNodeAt(pt, 24, false);
  if (rendered) return rendered;
  let best = null;
  let bestDist = 24;
  for (const n of state.payload.nodes) {
    const p = project([n.x, n.y]);
    const d = Math.hypot(pt.x - p.x, pt.y - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

function endpointHit(pt) {
  if (!state.selected) return false;
  const p = project(endpointCoord(state.selected));
  return Math.hypot(pt.x - p.x, pt.y - p.y) <= 16;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentIntersectionParameter(a, b, c, d) {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
}

function segmentsMeetBeforeEndpoint(start, end, a, b) {
  const t = segmentIntersectionParameter(start, end, a, b);
  if (t != null) return t < 1 - 1e-8;
  const rx = end[0] - start[0];
  const ry = end[1] - start[1];
  const lengthSquared = rx * rx + ry * ry;
  if (!lengthSquared) return false;
  const crossA = (a[0] - start[0]) * ry - (a[1] - start[1]) * rx;
  const crossB = (b[0] - start[0]) * ry - (b[1] - start[1]) * rx;
  if (Math.abs(crossA) > 1e-6 || Math.abs(crossB) > 1e-6) return false;
  const ta = ((a[0] - start[0]) * rx + (a[1] - start[1]) * ry) / lengthSquared;
  const tb = ((b[0] - start[0]) * rx + (b[1] - start[1]) * ry) / lengthSquared;
  return Math.max(0, Math.min(ta, tb)) < Math.min(1 - 1e-8, Math.max(ta, tb));
}

function geometryLineSegments(geometry) {
  if (!geometry) return [];
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
  const segments = [];
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) segments.push([line[index - 1], line[index]]);
  }
  return segments;
}

function geometryBoundarySegments(geometry) {
  if (!geometry) return [];
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  const segments = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) segments.push([ring[index - 1], ring[index]]);
    }
  }
  return segments;
}

function pointGeometryBoundaryDistance(point, geometry) {
  let best = Infinity;
  for (const [a, b] of geometryBoundarySegments(geometry)) {
    best = Math.min(best, pointSegmentDistance(
      { x: point[0], y: point[1] },
      { x: a[0], y: a[1] },
      { x: b[0], y: b[1] }
    ));
  }
  return best;
}

function pointCoveredByGeometry(point, geometry) {
  if (pointInGeometry(point, geometry)) return true;
  return geometryBoundarySegments(geometry).some(([a, b]) => pointSegmentDistance(
    { x: point[0], y: point[1] }, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }
  ) <= 0.01);
}

function segmentOutsideLength(start, end, geometry) {
  const cuts = [0, 1];
  for (const [a, b] of geometryBoundarySegments(geometry)) {
    const t = segmentIntersectionParameter(start, end, a, b);
    if (t != null) cuts.push(Math.max(0, Math.min(1, t)));
  }
  cuts.sort((a, b) => a - b);
  const unique = cuts.filter((value, index) => index === 0 || Math.abs(value - cuts[index - 1]) > 1e-8);
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  let outside = 0;
  for (let index = 1; index < unique.length; index += 1) {
    const low = unique[index - 1];
    const high = unique[index];
    const mid = (low + high) / 2;
    const point = [start[0] + (end[0] - start[0]) * mid, start[1] + (end[1] - start[1]) * mid];
    if (!pointCoveredByGeometry(point, geometry)) outside += length * (high - low);
  }
  return outside;
}

function connectorCrossesGstdm(start, end) {
  const bounds = { minX: Math.min(start[0], end[0]), maxX: Math.max(start[0], end[0]), minY: Math.min(start[1], end[1]), maxY: Math.max(start[1], end[1]) };
  const links = querySpatialGrid(state.linkGrid, bounds).filter((index) => linkBoundsIntersect(index, bounds));
  for (const index of links) {
    const coordinates = state.gstdmLines[index] || [];
    for (let pointIndex = 1; pointIndex < coordinates.length; pointIndex += 1) {
      if (segmentsMeetBeforeEndpoint(start, end, coordinates[pointIndex - 1], coordinates[pointIndex])) return true;
    }
  }
  return false;
}

function crossTazNodeOwner(nodeId) {
  const cleanNodeId = String(nodeId ?? "").replace(/\.0+$/, "");
  const currentTazId = String(state.payload?.tazId ?? "");
  for (const connector of state.globalConnectors || []) {
    if (String(connector.nodeId ?? "").replace(/\.0+$/, "") !== cleanNodeId) continue;
    const ownerTazId = String(connector.tazId ?? "");
    if (ownerTazId && ownerTazId !== currentTazId) return ownerTazId;
  }
  return "";
}

function bearingDegrees(start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

function angleDifference(first, second) {
  const difference = Math.abs(first - second) % 360;
  return Math.min(difference, 360 - difference);
}

function connectorAngleConflict(node, excludedCcPt = null) {
  const proposedAngle = bearingDegrees(state.payload.centroid, [node.x, node.y]);
  for (const connector of state.payload.connectors || []) {
    if (excludedCcPt && connector.ccPt === excludedCcPt) continue;
    const geometry = connector.geom;
    const endpoint = geometry?.coordinates?.[geometry.coordinates.length - 1];
    if (!endpoint) continue;
    const separation = angleDifference(
      proposedAngle,
      bearingDegrees(state.payload.centroid, endpoint)
    );
    if (separation < MIN_CC_ANGLE - 1e-9) {
      return { connector, separation };
    }
  }
  return null;
}

function connectorTargetValidation(node, excludedCcPt = null) {
  const ownerTazId = crossTazNodeOwner(node.id);
  if (ownerTazId) return `Node ${node.id} is already used by TAZ ${ownerTazId}. Choose a nearby different node.`;
  return "";
}

function manualOverrideWarnings(node, excludedCcPt = null) {
  const warnings = [];
  if (!node?.eligible) {
    const level = Number.isFinite(Number(node?.majorLevel)) ? `MAJOR_LEVEL ${Number(node.majorLevel)}` : "unknown MAJOR_LEVEL";
    warnings.push(`red major node ${node?.id || ""} (${level}) is blocked during preprocessing`);
  }
  const angleConflict = connectorAngleConflict(node, excludedCcPt);
  if (angleConflict) {
    warnings.push(`${angleConflict.separation.toFixed(1)} degrees from ${angleConflict.connector.ccPt}`);
  }
  const endpoint = [node.x, node.y];
  const outsideLength = segmentOutsideLength(state.payload.centroid, endpoint, state.payload.taz);
  if (outsideLength > 200.000001) warnings.push(`${outsideLength.toFixed(1)} ft outside TAZ`);
  if (connectorCrossesGstdm(state.payload.centroid, endpoint)) warnings.push("crosses a GSTDM link");
  return warnings;
}

function findTazLabelAt(pt, radius = 22) {
  let best = null;
  let bestDistance = radius;
  for (const centroid of state.data.centroids) {
    const point = project([centroid.x, centroid.y]);
    const distance = Math.hypot(pt.x - point.x, pt.y - point.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = state.tazById.get(String(centroid.id)) || null;
    }
  }
  return best;
}

function renderedNodeAt(pt, hitRadius, eligibleOnly) {
  if (!state.maplibreLoaded || state.maplibreMap.getZoom() < 11) return null;
  const box = [[pt.x - hitRadius, pt.y - hitRadius], [pt.x + hitRadius, pt.y + hitRadius]];
  const features = state.maplibreMap.queryRenderedFeatures(
    box,
    { layers: ["candidate-nodes-preview", "major-nodes", "non-major-nodes"] }
  );
  let best = null;
  let bestDistance = hitRadius;
  for (const feature of features) {
    const properties = feature.properties || {};
    const node = {
      id: String(properties.node_id || ""),
      x: Number(properties.x),
      y: Number(properties.y),
      majorLevel: Number(properties.major_level),
      outsideGa: properties.outside_ga === true || properties.outside_ga === 1 || properties.outside_ga === "true",
      majorInt: Number(properties.major_level) <= 2 ? "Y" : "N",
      eligible: properties.eligible === true || properties.eligible === 1 || properties.eligible === "true",
    };
    if (node.outsideGa) {
      node.majorInt = "N";
      node.eligible = true;
    }
    if (!node.id || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    if (eligibleOnly && !node.eligible) continue;
    const projected = project([node.x, node.y]);
    const distance = Math.hypot(pt.x - projected.x, pt.y - projected.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

function findTazAt(pt) {
  if (state.maplibreLoaded) {
    const feature = state.maplibreMap.queryRenderedFeatures(
      [pt.x, pt.y],
      { layers: ["global-taz-current-fill", "global-taz-hover-fill", "global-taz-fill"] }
    )[0];
    const rendered = feature ? state.tazById.get(String(feature.properties?.taz_id)) : null;
    if (rendered) return rendered;
  }
  const xy = unproject(pt);
  for (let index = state.data.tazs.length - 1; index >= 0; index -= 1) {
    const taz = state.data.tazs[index];
    const bounds = taz._bounds;
    if (xy[0] < bounds.minX || xy[0] > bounds.maxX || xy[1] < bounds.minY || xy[1] > bounds.maxY) continue;
    if (pointInGeometry(xy, taz.geom)) return taz;
  }
  return null;
}

function pointInGeometry(point, geometry) {
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  return false;
}

function pointInPolygon(point, rings) {
  if (!rings.length || !pointInRing(point, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(point, ring));
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function selectConnector(c) {
  state.selected = c;
  state.selectedMissingLink = null;
  state.contextConnector = c;
  state.pendingNode = null;
  state.hoveredNodeId = null;
  state.dirty = false;
  state.inspectorTab = "cc";
  updateInspector();
  updateMapLibreSelection();
  draw();
}

function applyEditToNode(node) {
  if (!state.selected) {
    toast("Select a connector first.");
    return;
  }
  const validationError = connectorTargetValidation(node, state.selected.ccPt);
  if (validationError) {
    showWarning(validationError);
    return;
  }
  const overrideWarnings = manualOverrideWarnings(node, state.selected.ccPt);
  const tazId = state.payload.tazId;
  const geom = { type: "LineString", coordinates: [state.payload.centroid, [node.x, node.y]] };
  const endBoundaryDist = pointGeometryBoundaryDistance([node.x, node.y], state.payload.taz);
  const edit = {
    nodeId: node.id,
    majorLevel: node.majorLevel,
    outsideLen: segmentOutsideLength(state.payload.centroid, [node.x, node.y], state.payload.taz),
    endBoundaryDist,
    interiorFallback: endBoundaryDist > 200.000001,
    status: "edited",
    note: qs("qcNote").value,
    geom,
  };
  pushEditHistory();
  state.edits[tazId] ||= {};
  state.edits[tazId].connectors ||= {};
  state.edits[tazId].connectors[state.selected.ccPt] = edit;
  markTazEdited(tazId);
  Object.assign(state.selected, edit);
  state.pendingNode = null;
  state.dirty = false;
  saveLocal();
  updateInspector();
  draw();
  const savedMessage = `Saved ${state.selected.ccPt} to node ${node.id}.`;
  if (overrideWarnings.length) {
    showWarning(`${savedMessage}\n\nManual override warning:\n- ${overrideWarnings.join("\n- ")}`);
  } else {
    toast(savedMessage);
  }
}

function selectMissingLink(link) {
  state.selectedMissingLink = link;
  state.selected = null;
  state.contextConnector = null;
  state.pendingNode = null;
  state.dirty = false;
  state.inspectorTab = "missing";
  updateInspector();
  updateMapLibreSelection();
  draw();
}

function zoomToMissingLink(link) {
  if (!link?.aCoord || !link?.bCoord) return;
  selectMissingLink(link);
  state.layers.hereMiss = true;
  const layerToggle = document.querySelector('input[data-layer="hereMiss"]');
  if (layerToggle) layerToggle.checked = true;
  syncMapLibreLayerState();
  const first = sourceToLonLat(link.aCoord);
  const second = sourceToLonLat(link.bCoord);
  const bounds = [
    [Math.min(first[0], second[0]), Math.min(first[1], second[1])],
    [Math.max(first[0], second[0]), Math.max(first[1], second[1])],
  ];
  if (state.maplibreLoaded) {
    state.maplibreMap.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 350 });
  } else {
    const span = Math.max(Math.abs(link.aCoord[0] - link.bCoord[0]), Math.abs(link.aCoord[1] - link.bCoord[1]));
    const pad = Math.max(200, span * 0.35);
    state.view = {
      minX: Math.min(link.aCoord[0], link.bCoord[0]) - pad,
      maxX: Math.max(link.aCoord[0], link.bCoord[0]) + pad,
      minY: Math.min(link.aCoord[1], link.bCoord[1]) - pad,
      maxY: Math.max(link.aCoord[1], link.bCoord[1]) + pad,
    };
    draw();
    scheduleViewportLoad(0);
  }
  status(`Zoomed to HERE_MISS ${link.a} - ${link.b}.`);
}

function clearSelection() {
  state.selected = null;
  state.selectedMissingLink = null;
  state.pendingNode = null;
  state.hoveredNodeId = null;
  state.dirty = false;
  state.contextConnector = null;
  hideContextMenu();
  hideMissingLinkContextMenu();
  updateInspector();
  updateMapLibreSelection();
  draw();
}

function showContextMenu(clientX, clientY, connector) {
  state.contextConnector = connector;
  const menu = qs("ccContextMenu");
  menu.classList.remove("hidden");
  const parent = state.canvas.parentElement.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = Math.min(clientX - parent.left, parent.width - menuRect.width - 8);
  const top = Math.min(clientY - parent.top, parent.height - menuRect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function hideContextMenu() {
  qs("ccContextMenu").classList.add("hidden");
}

function showMissingLinkContextMenu(clientX, clientY, link) {
  state.selectedMissingLink = link;
  const menu = qs("missingLinkContextMenu");
  menu.classList.remove("hidden");
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - menuRect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - menuRect.height - 8))}px`;
}

function hideMissingLinkContextMenu() {
  qs("missingLinkContextMenu").classList.add("hidden");
}

function showTazStatusMenu(clientX, clientY, tazId) {
  state.statusMenuTazId = String(tazId);
  const menu = qs("tazStatusMenu");
  qs("tazStatusMenuTitle").textContent = `TAZ ${tazId} status`;
  menu.classList.remove("hidden");
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - menuRect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - menuRect.height - 8))}px`;
}

function hideTazStatusMenu() {
  qs("tazStatusMenu").classList.add("hidden");
  state.statusMenuTazId = null;
}

function deleteSelectedConnector() {
  const connector = state.contextConnector || state.selected;
  if (!connector || !state.payload) {
    toast("Right-click a connector first.");
    return;
  }
  const tazId = state.payload.tazId;
  const remainingCount = Math.max(0, state.payload.connectors.length - 1);
  pushEditHistory();
  state.edits[tazId] ||= {};
  const addedConnector = (state.edits[tazId].added || []).includes(connector);
  const editKey = connectorEditKey(tazId, connector);
  if (addedConnector) {
    state.edits[tazId].added = (state.edits[tazId].added || []).filter((item) => item !== connector);
  } else {
    state.edits[tazId].deleted ||= [];
    if (!state.edits[tazId].deleted.includes(editKey)) state.edits[tazId].deleted.push(editKey);
    if (state.edits[tazId].connectors) delete state.edits[tazId].connectors[editKey];
  }
  markTazEdited(tazId);
  state.payload.connectors = state.payload.connectors.filter((item) => item !== connector);
  state.selected = null;
  state.contextConnector = null;
  state.pendingNode = null;
  state.dirty = false;
  saveLocal();
  updateInspector();
  draw();
  toast(`Deleted ${connector.ccPt} in this browser.${remainingCount < 1 ? " Manual override: TAZ now has 0 CCs." : ""}`);
}

function deleteSelectedMissingLink() {
  const link = state.selectedMissingLink;
  if (!link) {
    toast("Select or right-click a missing link first.");
    return;
  }
  pushEditHistory();
  state.missingLinks = state.missingLinks.filter((item) => item.pairKey !== link.pairKey);
  localStorage.setItem(STORAGE_KEYS.missingLinks, JSON.stringify(state.missingLinks));
  state.selectedMissingLink = null;
  hideMissingLinkContextMenu();
  refreshMapLibreMissingLinks();
  updateMapLibreSelection();
  updateMissingLinkModeUi();
  updateHistoryButtons();
  renderInspectorTables(true);
  draw();
  status(`Deleted HERE_MISS ${link.a} - ${link.b}.`);
  toast(`Deleted missing link ${link.a} - ${link.b}.`);
}

function updateInspector() {
  const c = state.selected;
  const tazId = state.payload?.tazId || "";
  renderInspectorTables();
  qs("dirtyBadge").classList.toggle("hidden", !state.dirty);
  const noteKey = c ? `${tazId}:${c.ccPt}` : `${tazId}:TAZ`;
  if (noteKey !== state.inspectorNoteKey) {
    qs("qcNote").value = c?.note ?? state.edits[tazId]?.note ?? "";
    state.inspectorNoteKey = noteKey;
  }
}

function setInspectorTab(tab) {
  if (!new Set(["cc", "missing", "taz"]).has(tab)) return;
  state.inspectorTab = tab;
  renderInspectorTables(true);
}

function syncInspectorTabs() {
  for (const button of document.querySelectorAll("[data-inspector-tab]")) {
    const active = button.dataset.inspectorTab === state.inspectorTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
  qs("ccTablePanel").classList.toggle("hidden", state.inspectorTab !== "cc");
  qs("missingLinkTablePanel").classList.toggle("hidden", state.inspectorTab !== "missing");
  qs("tazStatusTablePanel").classList.toggle("hidden", state.inspectorTab !== "taz");
}

function appendTableCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === "" ? "-" : String(value);
  if (className) cell.className = className;
  row.appendChild(cell);
}

function appendEditableTableCell(row, value, options = {}) {
  const cell = document.createElement("td");
  if (options.className) cell.className = options.className;
  const editor = options.choices ? document.createElement("select") : document.createElement("input");
  editor.className = `table-editor${options.type === "number" ? " table-editor-number" : ""}${options.editorClass ? ` ${options.editorClass}` : ""}`;
  if (options.ariaLabel) editor.setAttribute("aria-label", options.ariaLabel);
  if (options.title) editor.title = options.title;
  if (options.choices) {
    for (const choice of options.choices) {
      const option = document.createElement("option");
      option.value = typeof choice === "string" ? choice : choice.value;
      option.textContent = typeof choice === "string" ? choice : choice.label;
      editor.appendChild(option);
    }
  } else {
    editor.type = options.type || "text";
    if (options.min != null) editor.min = options.min;
    if (options.max != null) editor.max = options.max;
    if (options.step != null) editor.step = options.step;
  }
  const originalValue = value == null ? "" : String(value);
  editor.value = originalValue;
  for (const eventName of ["click", "dblclick", "pointerdown", "contextmenu"]) {
    editor.addEventListener(eventName, (event) => event.stopPropagation());
  }
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      editor.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      editor.value = originalValue;
      editor.blur();
    }
  });
  editor.addEventListener("change", async () => {
    if (editor.value === originalValue || typeof options.onCommit !== "function") return;
    editor.disabled = true;
    try {
      await options.onCommit(editor.value);
    } catch (error) {
      console.error(error);
      editor.value = originalValue;
      editor.disabled = false;
      toast(error.message || "Table edit failed.");
    }
  });
  cell.appendChild(editor);
  row.appendChild(cell);
}

function connectorEditKey(tazId, connector) {
  const edits = state.edits[String(tazId)]?.connectors || {};
  if (Object.prototype.hasOwnProperty.call(edits, connector.ccPt)) return connector.ccPt;
  return Object.entries(edits).find(([, value]) => String(value?.ccPt || "") === String(connector.ccPt))?.[0]
    || connector.ccPt;
}

function persistConnectorTableState(tazId, connector, editKey) {
  const tazEdit = state.edits[String(tazId)] ||= {};
  if ((tazEdit.added || []).includes(connector)) return;
  tazEdit.connectors ||= {};
  tazEdit.connectors[editKey] = {
    ...(tazEdit.connectors[editKey] || {}),
    ccPt: connector.ccPt,
    nodeId: connector.nodeId,
    majorLevel: connector.majorLevel,
    outsideLen: connector.outsideLen,
    endBoundaryDist: connector.endBoundaryDist,
    interiorFallback: connector.interiorFallback,
    status: connector.status,
    geom: connector.geom,
  };
}

function numericTableValue(rawValue, label, options = {}) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
  if (options.integer && !Number.isInteger(value)) throw new Error(`${label} must be a whole number.`);
  if (options.min != null && value < options.min) throw new Error(`${label} must be at least ${options.min}.`);
  if (options.max != null && value > options.max) throw new Error(`${label} must be no more than ${options.max}.`);
  return value;
}

async function editConnectorTableField(connector, field, rawValue) {
  if (!state.payload || !state.payload.connectors.includes(connector)) throw new Error("This connector is no longer active.");
  const tazId = String(state.payload.tazId);
  const editKey = connectorEditKey(tazId, connector);
  let value = rawValue;
  let targetNode = null;
  let overrideWarnings = [];
  if (field === "ccPt") {
    value = String(rawValue).trim();
    if (!value) throw new Error("CC_PT cannot be empty.");
    if (state.payload.connectors.some((item) => item !== connector && String(item.ccPt) === value)) {
      throw new Error(`CC_PT ${value} already exists in TAZ ${tazId}.`);
    }
  } else if (field === "nodeId") {
    value = CcFileLoader.cleanId(rawValue);
    if (!value) throw new Error("Node cannot be empty.");
    await ensureNodesByIds([value]);
    targetNode = state.nodeById.get(value);
    if (!targetNode) throw new Error(`Node ${value} was not found in the published node index.`);
    const validationError = connectorTargetValidation(targetNode, connector.ccPt);
    if (validationError && String(value) !== String(connector.nodeId)) throw new Error(validationError);
    if (String(value) !== String(connector.nodeId)) {
      overrideWarnings = manualOverrideWarnings(targetNode, connector.ccPt);
    }
  } else if (field === "majorLevel") {
    value = numericTableValue(rawValue, "Major", { min: 0 });
  } else if (field === "outsideLen") {
    value = numericTableValue(rawValue, "Outside ft", { min: 0 });
  } else if (field === "endBoundaryDist") {
    value = numericTableValue(rawValue, "End ft", { min: 0 });
  } else if (field === "interiorFallback") {
    value = String(rawValue).toUpperCase() === "INTERIOR";
  } else if (field === "status") {
    value = String(rawValue).trim().toLowerCase();
    if (!value) throw new Error("Status cannot be empty.");
  }

  pushEditHistory();
  if (field === "nodeId") {
    connector.nodeId = value;
    connector.majorLevel = targetNode.majorLevel;
    connector.geom = { type: "LineString", coordinates: [state.payload.centroid, [targetNode.x, targetNode.y]] };
    connector.outsideLen = segmentOutsideLength(state.payload.centroid, [targetNode.x, targetNode.y], state.payload.taz);
    connector.endBoundaryDist = pointGeometryBoundaryDistance([targetNode.x, targetNode.y], state.payload.taz);
    connector.interiorFallback = connector.endBoundaryDist > 200.000001;
  } else {
    connector[field] = value;
  }
  markTazEdited(tazId);
  persistConnectorTableState(tazId, connector, editKey);
  saveLocal();
  state.selected = connector;
  updateInspector();
  updateMapLibreSelection();
  draw();
  const updatedMessage = `Updated ${connector.ccPt} ${field}.`;
  if (overrideWarnings.length) {
    showWarning(`${updatedMessage}\n\nManual override warning:\n- ${overrideWarnings.join("\n- ")}`);
  } else {
    toast(updatedMessage);
  }
}

async function editMissingLinkTableField(link, field, rawValue) {
  if (!state.missingLinks.includes(link)) throw new Error("This missing link is no longer active.");
  let value = rawValue;
  let targetNode = null;
  if (field === "a" || field === "b") {
    value = CcFileLoader.cleanId(rawValue);
    if (!value) throw new Error(`${field.toUpperCase()} cannot be empty.`);
    const otherId = String(field === "a" ? link.b : link.a);
    if (value === otherId) throw new Error("A and B must be different nodes.");
    await ensureNodesByIds([value]);
    targetNode = state.nodeById.get(value);
    if (!targetNode) throw new Error(`Node ${value} was not found in the published node index.`);
    const nextA = field === "a" ? value : link.a;
    const nextB = field === "b" ? value : link.b;
    const nextKey = missingLinkPairKey(nextA, nextB);
    if (state.missingLinks.some((item) => item !== link && item.pairKey === nextKey)) {
      throw new Error(`HERE_MISS ${nextA} - ${nextB} already exists.`);
    }
  } else if (field === "records") {
    value = numericTableValue(rawValue, "Records", { integer: true, min: 1, max: 2 });
  } else if (field === "lanes") {
    value = numericTableValue(rawValue, "LANES", { min: 0 });
  } else if (field === "hereMiss") {
    value = numericTableValue(rawValue, "HERE_MISS", { integer: true, min: 0, max: 1 });
  } else if (field === "fclass") {
    value = numericTableValue(rawValue, "FCLASS", { integer: true, min: 0 });
  }

  pushEditHistory();
  if (field === "a" || field === "b") {
    link[field] = value;
    link[field === "a" ? "aCoord" : "bCoord"] = [Number(targetNode.x), Number(targetNode.y)];
    link.pairKey = missingLinkPairKey(link.a, link.b);
  } else {
    link[field] = value;
  }
  state.selectedMissingLink = link;
  localStorage.setItem(STORAGE_KEYS.missingLinks, JSON.stringify(state.missingLinks));
  refreshMapLibreMissingLinks();
  updateMapLibreSelection();
  updateMissingLinkModeUi();
  updateHistoryButtons();
  renderInspectorTables(true);
  draw();
  toast(`Updated HERE_MISS ${link.a} - ${link.b} ${field}.`);
}

function editTazNote(tazId, note) {
  const id = String(tazId);
  pushEditHistory();
  state.edits[id] ||= {};
  state.edits[id].note = String(note);
  saveLocal();
  if (String(state.payload?.tazId || "") === id) {
    qs("qcNote").value = String(note);
    state.inspectorNoteKey = `${id}:TAZ`;
  }
  updateInspector();
  toast(`Updated TAZ ${id} QC note.`);
}

function renderEmptyTableRow(body, columns, message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = columns;
  cell.className = "empty-row";
  cell.textContent = message;
  row.appendChild(cell);
  body.appendChild(row);
}

function compactFeet(value) {
  return value == null || !Number.isFinite(Number(value)) ? "-" : Number(value).toFixed(1);
}

function renderInspectorTables(force = false) {
  syncInspectorTabs();
  const connectors = state.payload?.connectors || [];
  const selectedCc = String(state.selected?.ccPt || "");
  const selectedMissing = String(state.selectedMissingLink?.pairKey || "");
  const signature = JSON.stringify({
    taz: state.payload?.tazId || "",
    connectors: connectors.map((item) => [item.ccPt, item.nodeId, item.majorLevel, item.outsideLen, item.endBoundaryDist, item.interiorFallback, item.status]),
    missing: state.missingLinks.map((item) => [item.pairKey, item.a, item.b, item.records, item.lanes, item.hereMiss, item.fclass]),
    tazRows: state.inspectorTab === "taz"
      ? activeReviewTazOrder().map((item) => [item.id, getTazStatus(item.id), state.connectorCountsByTaz.get(String(item.id)) ?? 0, state.edits[String(item.id)]?.note || ""])
      : [],
    selectedCc,
    selectedMissing,
    tab: state.inspectorTab,
  });
  if (!force && signature === state.inspectorRenderKey) return;
  state.inspectorRenderKey = signature;

  const ccBody = qs("ccTableBody");
  ccBody.replaceChildren();
  if (!connectors.length) {
    renderEmptyTableRow(ccBody, 7, "No CC records for the current TAZ.");
  } else {
    for (const connector of connectors) {
      const row = document.createElement("tr");
      row.dataset.ccPt = connector.ccPt;
      row.classList.toggle("selected-row", String(connector.ccPt) === selectedCc);
      row.addEventListener("click", () => selectConnector(connector));
      appendEditableTableCell(row, connector.ccPt, {
        ariaLabel: `CC_PT for ${connector.ccPt}`,
        onCommit: (value) => editConnectorTableField(connector, "ccPt", value),
      });
      appendEditableTableCell(row, connector.nodeId, {
        ariaLabel: `Node for ${connector.ccPt}`,
        onCommit: (value) => editConnectorTableField(connector, "nodeId", value),
      });
      appendEditableTableCell(row, connector.majorLevel, {
        type: "number",
        min: 0,
        step: "any",
        ariaLabel: `Major level for ${connector.ccPt}`,
        onCommit: (value) => editConnectorTableField(connector, "majorLevel", value),
      });
      appendEditableTableCell(row, compactFeet(connector.outsideLen), {
        type: "number",
        min: 0,
        step: "0.1",
        ariaLabel: `Outside feet for ${connector.ccPt}`,
        onCommit: (value) => editConnectorTableField(connector, "outsideLen", value),
      });
      appendEditableTableCell(row, compactFeet(connector.endBoundaryDist), {
        type: "number",
        min: 0,
        step: "0.1",
        ariaLabel: `End feet for ${connector.ccPt}`,
        onCommit: (value) => editConnectorTableField(connector, "endBoundaryDist", value),
      });
      appendEditableTableCell(row, connector.interiorFallback ? "INTERIOR" : "BOUNDARY", {
        choices: ["BOUNDARY", "INTERIOR"],
        ariaLabel: `Type for ${connector.ccPt}`,
        onCommit: (value) => editConnectorTableField(connector, "interiorFallback", value),
      });
      appendEditableTableCell(row, String(connector.status || "original").toUpperCase(), {
        ariaLabel: `Status for ${connector.ccPt}`,
        onCommit: (value) => editConnectorTableField(connector, "status", value),
      });
      ccBody.appendChild(row);
    }
  }

  const missingBody = qs("missingLinkTableBody");
  missingBody.replaceChildren();
  if (!state.missingLinks.length) {
    renderEmptyTableRow(missingBody, 6, "No HERE_MISS links have been added.");
  } else {
    for (const link of state.missingLinks) {
      const row = document.createElement("tr");
      row.dataset.missingPairKey = link.pairKey;
      row.classList.toggle("selected-row", String(link.pairKey) === selectedMissing);
      row.addEventListener("click", () => selectMissingLink(link));
      row.addEventListener("dblclick", (event) => {
        event.preventDefault();
        zoomToMissingLink(link);
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        selectMissingLink(link);
        showMissingLinkContextMenu(event.clientX, event.clientY, link);
      });
      appendEditableTableCell(row, link.a, {
        ariaLabel: `A node for HERE_MISS ${link.a} ${link.b}`,
        onCommit: (value) => editMissingLinkTableField(link, "a", value),
      });
      appendEditableTableCell(row, link.b, {
        ariaLabel: `B node for HERE_MISS ${link.a} ${link.b}`,
        onCommit: (value) => editMissingLinkTableField(link, "b", value),
      });
      appendEditableTableCell(row, link.records ?? 2, {
        type: "number",
        min: 1,
        max: 2,
        step: 1,
        ariaLabel: `Directional record count for HERE_MISS ${link.a} ${link.b}`,
        onCommit: (value) => editMissingLinkTableField(link, "records", value),
      });
      appendEditableTableCell(row, link.lanes ?? 1, {
        type: "number",
        min: 0,
        step: "any",
        ariaLabel: `LANES for HERE_MISS ${link.a} ${link.b}`,
        onCommit: (value) => editMissingLinkTableField(link, "lanes", value),
      });
      appendEditableTableCell(row, link.hereMiss ?? MISSING_LINK_DEFAULTS.hereMiss, {
        choices: ["0", "1"],
        ariaLabel: `HERE_MISS for ${link.a} ${link.b}`,
        onCommit: (value) => editMissingLinkTableField(link, "hereMiss", value),
      });
      appendEditableTableCell(row, link.fclass ?? MISSING_LINK_DEFAULTS.fclass, {
        type: "number",
        min: 0,
        step: 1,
        ariaLabel: `FCLASS for HERE_MISS ${link.a} ${link.b}`,
        onCommit: (value) => editMissingLinkTableField(link, "fclass", value),
      });
      missingBody.appendChild(row);
    }
  }

  const tazBody = qs("tazStatusTableBody");
  if (state.inspectorTab === "taz") {
    tazBody.replaceChildren();
    const currentTazId = String(state.payload?.tazId || "");
    for (const item of activeReviewTazOrder()) {
      const tazId = String(item.id);
      const row = document.createElement("tr");
      row.dataset.tazId = tazId;
      row.classList.toggle("current-row", tazId === currentTazId);
      row.addEventListener("click", () => goToTaz(tazId));
      appendTableCell(row, tazId, "computed-cell");
      appendEditableTableCell(row, getTazStatus(tazId), {
        choices: TAZ_STATUSES,
        ariaLabel: `QC status for TAZ ${tazId}`,
        onCommit: (value) => {
          setTazStatus(tazId, value);
          updateInspector();
        },
      });
      appendTableCell(row, state.connectorCountsByTaz.get(tazId) ?? 0, "computed-cell");
      appendEditableTableCell(row, state.edits[tazId]?.note || "", {
        className: "note-cell",
        editorClass: "table-editor-note",
        ariaLabel: `QC note for TAZ ${tazId}`,
        onCommit: (value) => editTazNote(tazId, value),
      });
      tazBody.appendChild(row);
    }
  }

  qs("ccTableCount").textContent = connectors.length;
  qs("missingLinkTableCount").textContent = state.missingLinks.length;
  qs("tazStatusTableCount").textContent = activeReviewTazOrder().length;
  requestAnimationFrame(() => {
    qs("ccTableBody").querySelector(".selected-row")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    qs("missingLinkTableBody").querySelector(".selected-row")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (state.inspectorTab === "taz") qs("tazStatusTableBody").querySelector(".current-row")?.scrollIntoView({ block: "nearest" });
  });
}

function saveQcNoteDraft(refreshUi) {
  if (!state.payload) return;
  const tazId = state.payload.tazId;
  const note = qs("qcNote").value;
  state.edits[tazId] ||= {};
  if (state.selected) {
    state.edits[tazId].connectors ||= {};
    const ccPt = state.selected.ccPt;
    state.edits[tazId].connectors[ccPt] ||= {};
    state.edits[tazId].connectors[ccPt].note = note;
    state.selected.note = note;
  } else {
    state.edits[tazId].note = note;
  }
  markTazEdited(tazId);
  localStorage.setItem(STORAGE_KEYS.edits, JSON.stringify(state.edits));
  if (refreshUi) {
    rebuildGlobalConnectorIndex();
    renderQueue();
    renderInspectorTables(true);
  }
}

function saveEdit() {
  if (!state.selected) {
    toast("Select a connector first.");
    return;
  }
  if (!state.pendingNode) {
    toast("Choose a new node first.");
    return;
  }
  applyEditToNode(state.pendingNode);
}

function toggleAddMode() {
  if (state.missingLinkMode) stopMissingLinkMode();
  state.addMode = !state.addMode;
  updateAddModeUi();
  toast(state.addMode ? "Tap any node to add CC. Red major nodes require a Warning acknowledgement." : "Add CC off.");
}

function updateAddModeUi() {
  const btn = qs("addCcBtn");
  btn.classList.toggle("active", state.addMode);
  btn.textContent = state.addMode ? "Adding CC..." : "Add CC";
}

function missingLinkPairKey(firstId, secondId) {
  const ids = [String(firstId), String(secondId)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return `${ids[0]}|${ids[1]}`;
}

function toggleMissingLinkMode() {
  if (state.missingLinkMode) {
    stopMissingLinkMode();
    toast("Add Missing Links off.");
    return;
  }
  state.addMode = false;
  updateAddModeUi();
  state.selected = null;
  state.selectedMissingLink = null;
  state.pendingNode = null;
  state.contextConnector = null;
  state.missingLinkMode = true;
  state.missingLinkStartNode = null;
  state.hoveredNode = null;
  state.hoveredNodeId = null;
  updateInspector();
  updateMapLibreSelection();
  updateMissingLinkModeUi();
  draw();
  toast("Add Missing Links: choose the first node.");
}

function stopMissingLinkMode() {
  state.missingLinkMode = false;
  state.missingLinkStartNode = null;
  state.hoveredNode = null;
  state.hoveredNodeId = null;
  updateMissingLinkModeUi();
  draw();
}

function inspectorWidthBounds() {
  const minimum = 280;
  const available = Math.max(minimum, window.innerWidth - 280 - 360);
  return { minimum, maximum: Math.max(minimum, Math.min(720, available)) };
}

function applyInspectorWidth(width, persist = false) {
  const bounds = inspectorWidthBounds();
  const next = Math.max(bounds.minimum, Math.min(bounds.maximum, Number(width) || 320));
  document.querySelector(".layout")?.style.setProperty("--inspector-width", `${Math.round(next)}px`);
  if (persist) localStorage.setItem(STORAGE_KEYS.inspectorWidth, JSON.stringify(Math.round(next)));
}

function clampInspectorWidth() {
  const width = qs("inspector")?.getBoundingClientRect().width || 320;
  applyInspectorWidth(width);
}

function bindInspectorResizer() {
  applyInspectorWidth(Number(readStoredJson(STORAGE_KEYS.inspectorWidth, 320)));
  const handle = qs("inspectorResizer");
  handle.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 1000) return;
    state.inspectorResizePointerId = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-inspector");
    event.preventDefault();
  });
  document.addEventListener("pointermove", (event) => {
    if (event.pointerId !== state.inspectorResizePointerId) return;
    applyInspectorWidth(window.innerWidth - event.clientX);
    event.preventDefault();
  });
  const finish = (event) => {
    if (event.pointerId !== state.inspectorResizePointerId) return;
    state.inspectorResizePointerId = null;
    document.body.classList.remove("resizing-inspector");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    applyInspectorWidth(qs("inspector").getBoundingClientRect().width, true);
    state.maplibreMap?.resize();
    resizeCanvas();
  };
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

function updateMissingLinkModeUi() {
  const button = qs("addMissingLinkBtn");
  const exportButton = qs("exportMissingLinksBtn");
  if (!button || !exportButton) return;
  button.classList.toggle("active", state.missingLinkMode);
  button.textContent = !state.missingLinkMode
    ? "Add Missing"
    : state.missingLinkStartNode
      ? `Pick Node 2 (${state.missingLinkStartNode.id})`
      : "Pick Node 1";
  exportButton.textContent = `Export HERE_MISS (${state.missingLinks.length})`;
  state.canvas?.classList.toggle("missing-link-mode", state.missingLinkMode);
}

function chooseMissingLinkNode(node) {
  if (!state.missingLinkStartNode) {
    state.missingLinkStartNode = { ...node };
    updateMissingLinkModeUi();
    draw();
    toast(`First node ${node.id} selected. Choose the second node.`);
    return;
  }
  const first = state.missingLinkStartNode;
  if (String(first.id) === String(node.id)) {
    toast("Choose a different second node.");
    return;
  }
  const pairKey = missingLinkPairKey(first.id, node.id);
  if (state.missingLinks.some((link) => link.pairKey === pairKey)) {
    toast(`HERE_MISS link ${first.id} - ${node.id} already exists.`);
    state.missingLinkStartNode = null;
    updateMissingLinkModeUi();
    draw();
    return;
  }
  pushEditHistory();
  const createdLink = {
    pairKey,
    a: String(first.id),
    b: String(node.id),
    aCoord: [Number(first.x), Number(first.y)],
    bCoord: [Number(node.x), Number(node.y)],
    records: 2,
    lanes: MISSING_LINK_DEFAULTS.lanes,
    hereMiss: MISSING_LINK_DEFAULTS.hereMiss,
    fclass: MISSING_LINK_DEFAULTS.fclass,
  };
  state.missingLinks.push(createdLink);
  state.selectedMissingLink = createdLink;
  state.inspectorTab = "missing";
  state.missingLinkStartNode = null;
  localStorage.setItem(STORAGE_KEYS.missingLinks, JSON.stringify(state.missingLinks));
  refreshMapLibreMissingLinks();
  updateMapLibreSelection();
  updateMissingLinkModeUi();
  updateHistoryButtons();
  renderInspectorTables(true);
  draw();
  status(`Added HERE_MISS ${first.id} - ${node.id}; export contains both directions.`);
  toast(`Added ${first.id} to ${node.id} and ${node.id} to ${first.id}. Choose another first node or exit the mode.`);
}

function addConnector(node) {
  const validationError = connectorTargetValidation(node);
  if (validationError) {
    showWarning(validationError);
    return;
  }
  const tazId = state.payload.tazId;
  pushEditHistory();
  const overrideWarnings = manualOverrideWarnings(node);
  const existingIds = new Set(state.payload.connectors.map((connector) => connector.ccPt));
  let count = 1;
  while (existingIds.has(`${tazId}_ADD${count}`)) count += 1;
  const endBoundaryDist = pointGeometryBoundaryDistance([node.x, node.y], state.payload.taz);
  const connector = {
    ccPt: `${tazId}_ADD${count}`,
    nodeId: node.id,
    majorLevel: node.majorLevel,
    outsideLen: segmentOutsideLength(state.payload.centroid, [node.x, node.y], state.payload.taz),
    endBoundaryDist,
    interiorFallback: endBoundaryDist > 200.000001,
    lineNodeDist: 0,
    status: "added",
    geom: { type: "LineString", coordinates: [state.payload.centroid, [node.x, node.y]] },
  };
  state.payload.connectors.push(connector);
  state.edits[tazId] ||= {};
  state.edits[tazId].added ||= [];
  state.edits[tazId].added.push(connector);
  markTazEdited(tazId);
  state.addMode = false;
  updateAddModeUi();
  saveLocal();
  selectConnector(connector);
  const countWarning = state.payload.connectors.length > 3 ? `${state.payload.connectors.length} CCs in TAZ` : "";
  const allWarnings = [...overrideWarnings, countWarning].filter(Boolean);
  const addedMessage = `Added ${connector.ccPt} to node ${node.id}.`;
  if (allWarnings.length) {
    showWarning(`${addedMessage}\n\nManual override warning:\n- ${allWarnings.join("\n- ")}`);
  } else {
    toast(addedMessage);
  }
}

async function markReviewed(direction = 1) {
  const tazId = state.payload.tazId;
  pushEditHistory();
  state.edits[tazId] ||= {};
  state.edits[tazId].qcStatus = "REVIEWED";
  delete state.edits[tazId].reviewed;
  state.edits[tazId].note = qs("qcNote").value;
  localStorage.setItem(STORAGE_KEYS.edits, JSON.stringify(state.edits));
  updateHistoryButtons();
  const scopedOrder = filteredReviewTazOrder();
  const filteredIndex = scopedOrder.findIndex((item) => String(item.id) === String(tazId));
  const targetIndex = filteredIndex + (direction < 0 ? -1 : 1);
  if (filteredIndex >= 0 && targetIndex >= 0 && targetIndex < scopedOrder.length) {
    const targetId = scopedOrder[targetIndex].id;
    await goToTaz(targetId);
    toast(`TAZ ${tazId} marked reviewed. Moved to TAZ ${targetId}.`);
  } else {
    toast(`TAZ ${tazId} marked reviewed. This is the ${direction < 0 ? "first" : "last"} TAZ in the current list.`);
  }
}

async function allConnectorsForExport() {
  const activeChunk = state.activeGlobalReviewChunk;
  const currentTazId = state.payload?.tazId;
  await ensureAllGlobalReviewChunks();
  const rows = [];
  for (const item of state.tazOrder) {
    const payload = basePayloadForTaz(item.id, false);
    applyImportedCc(payload);
    applySavedEdits(payload);
    const tazNote = state.edits[payload.tazId]?.note || "";
    for (const c of payload.connectors) {
      const endpoint = c.geom?.coordinates?.[c.geom.coordinates.length - 1];
      rows.push({
        A: payload.tazId,
        B: c.nodeId,
        FCLASS: 32,
        QC_NOTES: c.note ?? tazNote,
        ANGLE_DEG: endpoint ? bearingDegrees(payload.centroid, endpoint) : null,
      });
    }
    for (const c of payload.importUnavailableRows || []) {
      const geometry = c.geometry || c.geom;
      const endpoint = geometry?.coordinates?.[geometry.coordinates.length - 1];
      rows.push({
        A: payload.tazId,
        B: c.nodeId,
        FCLASS: 32,
        QC_NOTES: c.note ?? tazNote,
        ANGLE_DEG: endpoint ? bearingDegrees(payload.centroid, endpoint) : null,
      });
    }
  }
  await restoreSingleGlobalReviewChunk(activeChunk, currentTazId);
  return rows;
}

function findCrossTazNodeConflicts(rows) {
  const owners = new Map();
  for (const row of rows) {
    const nodeId = String(row.B ?? "").replace(/\.0+$/, "");
    const tazId = String(row.A ?? "").replace(/\.0+$/, "");
    if (!nodeId || !tazId) continue;
    if (!owners.has(nodeId)) owners.set(nodeId, new Set());
    owners.get(nodeId).add(tazId);
  }
  return Array.from(owners.entries())
    .filter(([, tazIds]) => tazIds.size > 1)
    .map(([nodeId, tazIds]) => ({ nodeId, tazIds: Array.from(tazIds).sort() }));
}

function cacheCrossTazSharedNodeReview(conflicts) {
  const nodesByTaz = new Map();
  for (const conflict of conflicts) {
    for (const tazId of conflict.tazIds) {
      if (!nodesByTaz.has(String(tazId))) nodesByTaz.set(String(tazId), []);
      nodesByTaz.get(String(tazId)).push(String(conflict.nodeId));
    }
  }
  for (const nodeIds of nodesByTaz.values()) {
    nodeIds.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }
  state.crossTazConflictNodesByTaz = nodesByTaz;
  state.crossTazConflictTazIds = new Set(nodesByTaz.keys());
  state.crossTazConflictFilterReady = true;
}

async function refreshCrossTazSharedNodeReview() {
  if (state.crossTazConflictFilterLoading) return;
  state.crossTazConflictFilterLoading = true;
  const filter = qs("queueFilter");
  filter.disabled = true;
  qs("tazListCount").textContent = "Scanning shared nodes...";
  status("Building cross-TAZ shared-node review list...");
  try {
    const sourceRows = await allConnectorsForExport();
    const conflicts = findCrossTazNodeConflicts(sourceRows);
    cacheCrossTazSharedNodeReview(conflicts);
    const currentBlockCount = filteredReviewTazOrder("cross-taz-shared-node").length;
    status(`Cross-TAZ review list ready: ${conflicts.length} shared node(s) across ${state.crossTazConflictTazIds.size} TAZ(s); ${currentBlockCount} in this block. Final CC export is allowed.`);
    toast(`Review list ready: ${conflicts.length} shared node(s) across ${state.crossTazConflictTazIds.size} TAZ(s).`);
  } catch (error) {
    console.error(error);
    filter.value = "all";
    status(`Could not build cross-TAZ review list: ${error.message}`);
    toast(`Cross-TAZ review scan failed: ${error.message}`);
  } finally {
    state.crossTazConflictFilterLoading = false;
    filter.disabled = false;
    renderQueue();
  }
}

function findTazAngleConflicts(rows) {
  const byTaz = new Map();
  for (const row of rows) {
    const tazId = String(row.A ?? "").replace(/\.0+$/, "");
    const angle = Number(row.ANGLE_DEG);
    if (!tazId || !Number.isFinite(angle)) continue;
    if (!byTaz.has(tazId)) byTaz.set(tazId, []);
    byTaz.get(tazId).push({ nodeId: String(row.B ?? ""), angle });
  }
  const conflicts = [];
  for (const [tazId, connectors] of byTaz) {
    for (let first = 0; first < connectors.length; first += 1) {
      for (let second = first + 1; second < connectors.length; second += 1) {
        const separation = angleDifference(connectors[first].angle, connectors[second].angle);
        if (separation < MIN_CC_ANGLE - 1e-9) {
          conflicts.push({
            tazId,
            nodeIds: [connectors[first].nodeId, connectors[second].nodeId],
            separation,
          });
        }
      }
    }
  }
  return conflicts;
}

async function exportFinalCc() {
  const format = document.querySelector('input[name="exportFormat"]:checked')?.value || "dbf";
  const includeNotes = qs("includeQcNotes").checked;
  hideExportDialog();
  toast(`Preparing final CC ${format.toUpperCase()}${includeNotes ? " and QCNOTES" : ""}...`);
  const sourceRows = await allConnectorsForExport();
  const conflicts = findCrossTazNodeConflicts(sourceRows);
  cacheCrossTazSharedNodeReview(conflicts);
  const rows = [];
  const noteRows = [];
  for (const r of sourceRows) {
    rows.push(r, { A: r.B, B: r.A, FCLASS: 32 });
    noteRows.push(
      { A: r.A, B: r.B, QC_NOTES: r.QC_NOTES },
      { A: r.B, B: r.A, QC_NOTES: r.QC_NOTES }
    );
  }
  if (!rows.length) {
    toast("No loaded connectors to export yet.");
    return;
  }
  if (format === "csv") {
    downloadBlob(makeCsv(rows, ["A", "B", "FCLASS"]), "cube_taz_cc_public.csv", "text/csv;charset=utf-8");
    if (includeNotes) {
      setTimeout(() => downloadBlob(makeCsv(noteRows, ["A", "B", "QC_NOTES"]), "cube_taz_cc_QCNOTES.csv", "text/csv;charset=utf-8"), 120);
    }
  } else {
    downloadBlob(makeDbf(rows), "cube_taz_cc_public.dbf", "application/octet-stream");
    if (includeNotes) {
      setTimeout(() => {
        downloadBlob(
          makeDbf(noteRows, [
            { name: "A", len: 20 },
            { name: "B", len: 20 },
            { name: "QC_NOTES", len: 250 },
          ]),
          "cube_taz_cc_QCNOTES.dbf",
          "application/octet-stream"
        );
      }, 120);
    }
  }
  const noteStatus = includeNotes ? ` and ${noteRows.length} QC note records` : " without QCNOTES";
  const sharedNodeStatus = conflicts.length
    ? ` Warning: ${conflicts.length} cross-TAZ shared node(s) remain; use the Cross-TAZ Shared Node Review filter.`
    : "";
  status(`Exported ${rows.length} ${format.toUpperCase()} CC records${noteStatus}.${sharedNodeStatus}`);
  if (conflicts.length) {
    toast(`Exported with ${conflicts.length} cross-TAZ shared node(s). Review filter is ready.`);
  }
}

function missingLinkExportRows() {
  const rows = [];
  for (const link of state.missingLinks) {
    const properties = {
      LANES: Number.isFinite(Number(link.lanes)) ? Number(link.lanes) : MISSING_LINK_DEFAULTS.lanes,
      HERE_MISS: Number.isFinite(Number(link.hereMiss)) ? Number(link.hereMiss) : MISSING_LINK_DEFAULTS.hereMiss,
      FCLASS: Number.isFinite(Number(link.fclass)) ? Number(link.fclass) : MISSING_LINK_DEFAULTS.fclass,
    };
    rows.push({ A: link.a, B: link.b, ...properties });
    if ((Number(link.records) || 2) >= 2) rows.push({ A: link.b, B: link.a, ...properties });
  }
  return rows;
}

function exportMissingLinks() {
  const format = document.querySelector('input[name="missingLinksExportFormat"]:checked')?.value || "dbf";
  hideMissingLinksExportDialog();
  const rows = missingLinkExportRows();
  if (!rows.length) {
    toast("No HERE_MISS links to export yet.");
    return;
  }
  const fields = ["A", "B", "LANES", "HERE_MISS", "FCLASS"];
  if (format === "csv") {
    downloadBlob(makeCsv(rows, fields), "HERE_MISS_links.csv", "text/csv;charset=utf-8");
  } else {
    downloadBlob(makeDbf(rows, [
      { name: "A", len: 20 },
      { name: "B", len: 20 },
      { name: "LANES", type: "N", len: 5 },
      { name: "HERE_MISS", type: "N", len: 5 },
      { name: "FCLASS", type: "N", len: 5 },
    ]), "HERE_MISS_links.dbf", "application/octet-stream");
  }
  status(`Exported ${rows.length} HERE_MISS records as ${format.toUpperCase()}.`);
  toast(`Exported ${rows.length} HERE_MISS records.`);
}

function tazQcStatusRows() {
  return state.tazOrder.map((item) => ({
    TAZ_ID: String(item.id),
    QC_STATUS: getTazStatus(item.id),
    QC_NOTES: state.edits[String(item.id)]?.note || "",
  }));
}

async function exportTazQcStatus() {
  const format = document.querySelector('input[name="tazStatusExportFormat"]:checked')?.value || "dbf";
  hideTazStatusExportDialog();
  const rows = tazQcStatusRows();
  if (format === "dbf") {
    downloadBlob(makeDbf(rows, [
      { name: "TAZ_ID", len: 20 },
      { name: "QC_STATUS", len: 20 },
      { name: "QC_NOTES", len: 250 },
    ]), "taz_qc_status.dbf", "application/octet-stream");
  } else if (format === "csv") {
    downloadBlob(makeCsv(rows, ["TAZ_ID", "QC_STATUS", "QC_NOTES"]), "taz_qc_status.csv", "text/csv;charset=utf-8");
  } else {
    toast("Preparing TAZ QC Status Shapefile...");
    const activeChunk = state.activeGlobalReviewChunk;
    const currentTazId = state.payload?.tazId;
    await ensureAllGlobalReviewChunks();
    const features = rows.map((row) => ({ ...row, geom: state.tazById.get(row.TAZ_ID)?.geom }));
    const archive = await makeTazStatusShapefile(features);
    await restoreSingleGlobalReviewChunk(activeChunk, currentTazId);
    downloadBlob(archive, "taz_qc_status_shapefile.zip", "application/zip");
  }
  const formatLabel = format === "dbf" ? "DBF" : format === "csv" ? "CSV" : "Shapefile ZIP";
  status(`Exported ${rows.length} TAZ QC status records as ${formatLabel}.`);
  toast(`Exported ${rows.length} TAZ QC statuses.`);
}

function makeDbf(rows, fields = [
    { name: "A", len: 20 },
    { name: "B", len: 20 },
    { name: "FCLASS", len: 8 },
  ], encoding = "latin1") {
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((s, f) => s + f.len, 0);
  const buffer = new ArrayBuffer(headerLen + rows.length * recordLen + 1);
  const bytes = new Uint8Array(buffer);
  const now = new Date();
  bytes[0] = 0x03;
  bytes[1] = now.getFullYear() - 1900;
  bytes[2] = now.getMonth() + 1;
  bytes[3] = now.getDate();
  writeInt(bytes, 4, rows.length);
  writeShort(bytes, 8, headerLen);
  writeShort(bytes, 10, recordLen);
  fields.forEach((field, i) => {
    const off = 32 + i * 32;
    writeAscii(bytes, off, field.name, 11);
    bytes[off + 11] = String(field.type || "C").charCodeAt(0);
    bytes[off + 16] = field.len;
    bytes[off + 17] = field.decimals || 0;
  });
  bytes[headerLen - 1] = 0x0d;
  rows.forEach((row, i) => {
    let off = headerLen + i * recordLen;
    bytes[off++] = 0x20;
    for (const field of fields) {
      const value = String(row[field.name] ?? "").replace(/[\r\n\t]+/g, " ");
      const output = field.type === "N"
        ? value.slice(0, field.len).padStart(field.len, " ")
        : value.slice(0, field.len).padEnd(field.len, " ");
      if (encoding === "utf8" && field.type !== "N") writeUtf8Padded(bytes, off, output, field.len);
      else writeAscii(bytes, off, output, field.len);
      off += field.len;
    }
  });
  bytes[bytes.length - 1] = 0x1a;
  return new Blob([buffer]);
}

function writeAscii(bytes, offset, text, len) {
  for (let i = 0; i < len; i++) {
    const code = i < text.length ? text.charCodeAt(i) : 0;
    bytes[offset + i] = code <= 255 ? code : 63;
  }
}

function writeInt(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = (value >> 8) & 255;
  bytes[offset + 2] = (value >> 16) & 255;
  bytes[offset + 3] = (value >> 24) & 255;
}

function writeShort(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = (value >> 8) & 255;
}

function makeCsv(rows, fields) {
  const escapeCsv = (value) => {
    const text = String(value ?? "").replace(/\r\n|\r|\n/g, " ");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [fields.join(","), ...rows.map((row) => fields.map((field) => escapeCsv(row[field])).join(","))];
  return new Blob(["\ufeff", lines.join("\r\n"), "\r\n"], { type: "text/csv;charset=utf-8" });
}

function writeUtf8Padded(bytes, offset, text, len) {
  bytes.fill(0x20, offset, offset + len);
  const encoder = new TextEncoder();
  let cursor = 0;
  for (const character of text) {
    const encoded = encoder.encode(character);
    if (cursor + encoded.length > len) break;
    bytes.set(encoded, offset + cursor);
    cursor += encoded.length;
  }
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}

function normalizeShapefileRing(rawRing, isOuter) {
  const ring = rawRing.map(([x, y]) => [Number(x), Number(y)]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push([...ring[0]]);
  const shouldReverse = isOuter ? ringArea(ring) > 0 : ringArea(ring) < 0;
  return shouldReverse ? ring.reverse() : ring;
}

function shapeBounds(records) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const record of records) {
    for (const ring of record.rings) {
      for (const [x, y] of ring) {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
  }
  return Number.isFinite(bounds.minX) ? bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

function writeShapefileHeader(view, byteLength, bounds) {
  view.setInt32(0, 9994, false);
  view.setInt32(24, byteLength / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, 5, true);
  view.setFloat64(36, bounds.minX, true);
  view.setFloat64(44, bounds.minY, true);
  view.setFloat64(52, bounds.maxX, true);
  view.setFloat64(60, bounds.maxY, true);
}

function makePolygonShapefile(features) {
  const records = features.map((feature) => {
    if (feature.geom?.type !== "Polygon") throw new Error(`TAZ ${feature.TAZ_ID} does not have Polygon geometry.`);
    const rings = feature.geom.coordinates.map((ring, index) => normalizeShapefileRing(ring, index === 0)).filter((ring) => ring.length >= 4);
    const bounds = shapeBounds([{ rings }]);
    const pointCount = rings.reduce((sum, ring) => sum + ring.length, 0);
    const contentBytes = 44 + rings.length * 4 + pointCount * 16;
    return { rings, bounds, pointCount, contentBytes };
  });
  const bounds = shapeBounds(records);
  const shpBytes = 100 + records.reduce((sum, record) => sum + 8 + record.contentBytes, 0);
  const shxBytes = 100 + records.length * 8;
  const shp = new Uint8Array(shpBytes);
  const shx = new Uint8Array(shxBytes);
  const shpView = new DataView(shp.buffer);
  const shxView = new DataView(shx.buffer);
  writeShapefileHeader(shpView, shpBytes, bounds);
  writeShapefileHeader(shxView, shxBytes, bounds);
  let shpOffset = 100;
  records.forEach((record, recordIndex) => {
    const contentWords = record.contentBytes / 2;
    const shxOffset = 100 + recordIndex * 8;
    shxView.setInt32(shxOffset, shpOffset / 2, false);
    shxView.setInt32(shxOffset + 4, contentWords, false);
    shpView.setInt32(shpOffset, recordIndex + 1, false);
    shpView.setInt32(shpOffset + 4, contentWords, false);
    let offset = shpOffset + 8;
    shpView.setInt32(offset, 5, true);
    offset += 4;
    [record.bounds.minX, record.bounds.minY, record.bounds.maxX, record.bounds.maxY].forEach((value) => {
      shpView.setFloat64(offset, value, true);
      offset += 8;
    });
    shpView.setInt32(offset, record.rings.length, true);
    shpView.setInt32(offset + 4, record.pointCount, true);
    offset += 8;
    let pointIndex = 0;
    record.rings.forEach((ring) => {
      shpView.setInt32(offset, pointIndex, true);
      offset += 4;
      pointIndex += ring.length;
    });
    record.rings.flat().forEach(([x, y]) => {
      shpView.setFloat64(offset, x, true);
      shpView.setFloat64(offset + 8, y, true);
      offset += 16;
    });
    shpOffset += 8 + record.contentBytes;
  });
  return { shp, shx };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entries) {
  const encoder = new TextEncoder();
  const prepared = entries.map(({ name, data }) => {
    const nameBytes = encoder.encode(name);
    const bytes = data instanceof Uint8Array ? data : encoder.encode(String(data));
    return { nameBytes, bytes, crc: crc32(bytes), localOffset: 0 };
  });
  const localSize = prepared.reduce((sum, entry) => sum + 30 + entry.nameBytes.length + entry.bytes.length, 0);
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
  const zip = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(zip.buffer);
  let offset = 0;
  prepared.forEach((entry) => {
    entry.localOffset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.bytes.length, true);
    view.setUint32(offset + 22, entry.bytes.length, true);
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    zip.set(entry.nameBytes, offset + 30);
    zip.set(entry.bytes, offset + 30 + entry.nameBytes.length);
    offset += 30 + entry.nameBytes.length + entry.bytes.length;
  });
  const centralOffset = offset;
  prepared.forEach((entry) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.bytes.length, true);
    view.setUint32(offset + 24, entry.bytes.length, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint32(offset + 42, entry.localOffset, true);
    zip.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.length;
  });
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralOffset, true);
  return new Blob([zip], { type: "application/zip" });
}

async function makeTazStatusShapefile(features) {
  const { shp, shx } = makePolygonShapefile(features);
  const dbf = new Uint8Array(await makeDbf(features, [
    { name: "TAZ_ID", len: 20 },
    { name: "QC_STATUS", len: 20 },
    { name: "QC_NOTES", len: 250 },
  ], "utf8").arrayBuffer());
  const prj = 'PROJCS["NAD83_Georgia_Statewide_Lambert_US_Foot",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",-83.5],PARAMETER["Standard_Parallel_1",31.4166666666667],PARAMETER["Standard_Parallel_2",34.2833333333333],PARAMETER["Latitude_Of_Origin",0],UNIT["Foot_US",0.3048006096012192]]';
  return makeStoredZip([
    { name: "taz_qc_status.shp", data: shp },
    { name: "taz_qc_status.shx", data: shx },
    { name: "taz_qc_status.dbf", data: dbf },
    { name: "taz_qc_status.prj", data: prj },
    { name: "taz_qc_status.cpg", data: "UTF-8" },
  ]);
}

function downloadBlob(blob, filename, type) {
  const url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

init().catch((error) => {
  console.error(error);
  status(`Failed to load public QAQC data: ${error.message}`);
  toast(error.message);
});
