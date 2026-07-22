const STORAGE_KEYS = Object.freeze({
  edits: "tazQaqcEdits",
  importedCc: "tazQaqcImportedCc",
  layerOrder: "tazLayerOrder",
});
const TAZ_STATUSES = Object.freeze(["FLAG", "EDITED", "REVIEWED"]);

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

const state = {
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  data: null,
  index: null,
  tazOrder: [],
  currentIndex: 0,
  payload: null,
  tazById: new Map(),
  centroidById: new Map(),
  connectorsByTaz: new Map(),
  nodeById: new Map(),
  nodeGrid: new Map(),
  linkGrid: new Map(),
  connectorGrid: new Map(),
  globalConnectors: [],
  selected: null,
  pendingNode: null,
  dirty: false,
  addMode: false,
  view: null,
  dragStart: null,
  pointerStart: null,
  pointerMoved: false,
  isPanning: false,
  isDraggingEndpoint: false,
  activePointerId: null,
  lastTapAt: 0,
  basemap: "road",
  tileCache: new Map(),
  tileRetries: new Map(),
  contextConnector: null,
  undoStack: [],
  redoStack: [],
  importedCc: null,
  importedSource: "",
  layers: { allTaz: true, gstdm: true, majorNodes: true, nonMajorNodes: true, connectors: true, centroids: true, tazLabels: true },
  layerOrder: ["tazLabels", "centroids", "connectors", "majorNodes", "nonMajorNodes", "gstdm", "allTaz"],
  draggedLayer: null,
  layerDragPointerId: null,
  inspectorNoteKey: null,
  hoveredTazId: null,
  statusMenuTazId: null,
  edits: readStoredJson(STORAGE_KEYS.edits, {}),
};

const qs = (id) => document.getElementById(id);
const SOURCE_PROJ =
  "+proj=lcc +lat_0=0 +lon_0=-83.5 +lat_1=31.4166666666667 +lat_2=34.2833333333333 +x_0=0 +y_0=0 +datum=NAD83 +units=us-ft +no_defs +type=crs";
const FT_TO_M = 0.3048006096012192;

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

async function init() {
  state.canvas = qs("mapCanvas");
  state.ctx = state.canvas.getContext("2d");
  bindControls();
  bindCanvas();
  resizeCanvas();
  window.addEventListener("resize", () => {
    resizeCanvas();
    draw();
  });

  status("Loading all TAZs, CCs, nodes, and links...");
  state.data = await fetchJson("data/all.json");
  state.index = state.data;
  state.tazOrder = state.data.tazOrder;
  buildDataIndexes();
  restoreImportedCc();
  rebuildGlobalConnectorIndex();
  updateImportedCcUi();
  renderQueue();
  await goToTaz(state.tazOrder[0].id);
  showAllStatus();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

function bindControls() {
  qs("prevBtn").addEventListener("click", () => shiftTaz(-1));
  qs("nextBtn").addEventListener("click", () => shiftTaz(1));
  qs("zoomAllBtn").addEventListener("click", zoomAll);
  qs("undoBtn").addEventListener("click", undoEdit);
  qs("redoBtn").addEventListener("click", redoEdit);
  qs("jumpBtn").addEventListener("click", () => goToTaz(qs("jumpInput").value.trim()));
  qs("saveBtn").addEventListener("click", saveEdit);
  qs("addCcBtn").addEventListener("click", toggleAddMode);
  qs("reviewedBtn").addEventListener("click", markReviewed);
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
  qs("instructionsBtn").addEventListener("click", showInstructions);
  qs("closeInstructionsBtn").addEventListener("click", hideInstructions);
  qs("clearBtn").addEventListener("click", clearSelection);
  qs("ctxAddCcBtn").addEventListener("click", () => {
    hideContextMenu();
    state.addMode = true;
    updateAddModeUi();
    toast("Tap an eligible node to add CC.");
  });
  qs("ctxDeleteCcBtn").addEventListener("click", () => {
    hideContextMenu();
    deleteSelectedConnector();
  });
  document.querySelectorAll("[data-taz-status]").forEach((button) => {
    button.addEventListener("click", () => setTazStatus(state.statusMenuTazId, button.dataset.tazStatus));
  });
  document.addEventListener("click", (event) => {
    if (!qs("ccContextMenu").contains(event.target)) hideContextMenu();
    if (!qs("tazStatusMenu").contains(event.target)) hideTazStatusMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!qs("ccContextMenu").contains(event.target)) hideContextMenu();
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
      hideTazStatusMenu();
      hideInstructions();
    }
  });
  qs("queueFilter").addEventListener("change", renderQueue);
  qs("basemapSelect").addEventListener("change", () => {
    state.basemap = qs("basemapSelect").value;
    draw();
  });
  restoreLayerOrder();
  document.querySelectorAll(".legend input[data-layer]").forEach((input) => {
    input.addEventListener("change", () => {
      state.layers[input.dataset.layer] = input.checked;
      draw();
    });
  });
  bindLayerReordering();
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
  draw();
}

function showInstructions() {
  qs("instructionsPanel").classList.remove("hidden");
}

function hideInstructions() {
  qs("instructionsPanel").classList.add("hidden");
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

function bindCanvas() {
  state.canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const pt = eventPoint(event);
    const connector = findConnectorAt(pt);
    if (connector) {
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
    zoomAt(event.offsetX, event.offsetY, event.deltaY < 0 ? 0.82 : 1.22);
  });
  state.canvas.addEventListener("dblclick", (event) => {
    const pt = eventPoint(event);
    zoomAt(pt.x, pt.y, 0.72);
  });
  state.canvas.addEventListener("pointerdown", (event) => {
    hideContextMenu();
    hideTazStatusMenu();
    const pt = eventPoint(event);
    state.pointerStart = pt;
    state.pointerMoved = false;
    state.activePointerId = event.pointerId;
    state.canvas.setPointerCapture(event.pointerId);
    if (state.selected && endpointHit(pt)) {
      state.isDraggingEndpoint = true;
      state.canvas.classList.add("dragging");
      event.preventDefault();
      return;
    }
    const connector = findConnectorAt(pt);
    if (connector) {
      state.addMode = false;
      updateAddModeUi();
      selectConnector(connector);
      event.preventDefault();
      return;
    }
    const node = findNodeAt(pt);
    if (node && state.addMode) {
      addConnector(node);
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
      zoomAt(pt.x, pt.y, 0.78);
      state.lastTapAt = 0;
      event.preventDefault();
      return;
    }
    state.lastTapAt = now;
    state.isPanning = true;
    state.dragStart = pt;
    state.canvas.classList.add("panning");
    event.preventDefault();
  });
  state.canvas.addEventListener("pointermove", (event) => {
    if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;
    const pt = eventPoint(event);
    if (state.isDraggingEndpoint) {
      state.pendingNode = nearestEligibleNode(pt);
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
    updateHoveredTaz(pt);
  });
  state.canvas.addEventListener("pointerup", finishPointer);
  state.canvas.addEventListener("pointercancel", finishPointer);
  state.canvas.addEventListener("pointerleave", () => updateHoveredTaz(null));
}

function updateHoveredTaz(pt) {
  if (!state.data || !state.payload) return;
  const hit = pt ? findTazAt(pt) : null;
  const nextId = hit && String(hit.id) !== String(state.payload?.tazId) ? String(hit.id) : null;
  if (nextId === state.hoveredTazId) return;
  state.hoveredTazId = nextId;
  state.canvas.classList.toggle("taz-hover", Boolean(nextId));
  draw();
}

function finishPointer(event) {
  if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;
  const mapClick = event.type === "pointerup" && state.isPanning && !state.pointerMoved ? eventPoint(event) : null;
  if (state.isDraggingEndpoint) {
    if (state.pendingNode) {
      applyEditToNode(state.pendingNode);
    } else {
      toast("No eligible node near endpoint.");
    }
    updateInspector();
  }
  state.isDraggingEndpoint = false;
  state.isPanning = false;
  state.dragStart = null;
  state.pointerStart = null;
  state.pointerMoved = false;
  state.activePointerId = null;
  state.canvas.classList.remove("dragging", "panning");
  if (event.pointerId !== undefined && state.canvas.hasPointerCapture(event.pointerId)) {
    state.canvas.releasePointerCapture(event.pointerId);
  }
  if (mapClick) {
    const taz = findTazAt(mapClick);
    if (taz && String(taz.id) !== String(state.payload.tazId)) {
      void goToTaz(taz.id);
      return;
    }
  }
  draw();
}

function eventPoint(event) {
  const rect = state.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
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
  const edit = state.edits[String(tazId)] || {};
  const explicit = String(edit.qcStatus || "").toUpperCase();
  if (TAZ_STATUSES.includes(explicit)) return explicit;
  if (edit.reviewed) return "REVIEWED";
  if (hasUserChanges(tazId) || importedCcDiffers(tazId)) return "EDITED";
  return "FLAG";
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

function renderQueue() {
  const filter = qs("queueFilter").value;
  const list = qs("queueList");
  list.innerHTML = "";
  state.tazOrder
    .filter((item) => {
      return filter === "all" || getTazStatus(item.id).toLowerCase() === filter;
    })
    .forEach((item) => {
      const connectorCount = state.importedCc ? (state.importedCc.get(String(item.id)) || []).length : item.connectors;
      const row = document.createElement("div");
      row.className = `queue-item ${item.id === state.payload?.tazId ? "active" : ""}`;
      const qcStatus = getTazStatus(item.id);
      row.innerHTML = `<div><strong>${item.id}</strong><br><small>${item.issue || "No issue noted"} | ${connectorCount} CC</small></div><span class="pill ${qcStatus.toLowerCase()}">${qcStatus}</span>`;
      row.addEventListener("click", () => goToTaz(item.id));
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        showTazStatusMenu(event.clientX, event.clientY, item.id);
      });
      list.appendChild(row);
    });
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
  state.nodeGrid = new Map();
  state.nodeById = new Map();
  for (const node of state.data.nodes) {
    state.nodeById.set(CcFileLoader.cleanId(node.id), node);
    addToSpatialGrid(state.nodeGrid, node, { minX: node.x, maxX: node.x, minY: node.y, maxY: node.y });
  }
  state.linkGrid = new Map();
  for (const link of state.data.links) {
    link._bounds = geomBounds(link.geom);
    addToSpatialGrid(state.linkGrid, link, link._bounds);
  }
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
    links = querySpatialGrid(state.linkGrid, context).filter((link) => boundsIntersect(link._bounds, context));
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
  for (const item of state.tazOrder) {
    const payload = basePayloadForTaz(item.id, false);
    applyImportedCc(payload);
    applySavedEdits(payload);
    for (const connector of payload.connectors) connectors.push({ ...connector, tazId: payload.tazId });
  }
  state.globalConnectors = connectors;
  state.connectorGrid = new Map();
  for (const connector of connectors) {
    connector._bounds = geomBounds(connector.geom);
    addToSpatialGrid(state.connectorGrid, connector, connector._bounds);
  }
}

async function goToTaz(id, keepView = false) {
  const index = state.tazOrder.findIndex((item) => String(item.id) === String(id));
  if (index < 0) {
    toast(`TAZ ${id} not found.`);
    return;
  }
  if (state.dirty && !confirm("Current edit is not saved. Continue?")) return;
  state.currentIndex = index;
  const item = state.tazOrder[index];
  state.payload = basePayloadForTaz(item.id);
  applyImportedCc(state.payload);
  applySavedEdits(state.payload);
  state.selected = null;
  state.pendingNode = null;
  state.dirty = false;
  state.hoveredTazId = null;
  state.canvas.classList.remove("taz-hover");
  state.inspectorNoteKey = null;
  qs("jumpInput").value = item.id;
  qs("currentTaz").textContent = item.id;
  if (!keepView) setViewToPayload();
  renderQueue();
  updateInspector();
  draw();
  const unavailable = state.payload.importUnavailableRows?.length || 0;
  const importWarning = unavailable ? `; ${unavailable} uploaded CC(s) reference nodes outside this page context` : "";
  status(`TAZ ${item.id}: ${state.payload.connectors.length} connector(s), ${state.payload.nodes.length} nodes, ${state.payload.links.length} GSTDM links${importWarning}`);
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
    return [{
      ccPt: row.ccPt || `${payload.tazId}_UPLOAD${index + 1}`,
      nodeId: row.nodeId,
      majorLevel: node?.majorLevel ?? null,
      outsideLen: 0,
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
  if (!state.importedCc) {
    qs("uploadBadge").classList.add("hidden");
    qs("resetCcBtn").classList.add("hidden");
    qs("runFolder").textContent = `${state.index.generatedFrom} | ${state.index.count} TAZs | ${state.data.connectors.length} CCs`;
    return;
  }
  const count = Array.from(state.importedCc.values()).reduce((sum, rows) => sum + rows.length, 0);
  qs("uploadBadge").textContent = `${count} uploaded CC`;
  qs("uploadBadge").title = state.importedSource;
  qs("uploadBadge").classList.remove("hidden");
  qs("resetCcBtn").classList.remove("hidden");
  qs("runFolder").textContent = `${state.importedSource} | ${count} CCs`;
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
    const compactByTaz = Object.fromEntries(Object.entries(result.byTaz).map(([tazId, rows]) => [
      tazId,
      rows.map(({ nodeId, ccPt, geometry }) => ({ nodeId, ccPt, geometry: compactImportedGeometry(geometry) })),
    ]));
    state.importedCc = new Map(Object.entries(compactByTaz));
    state.importedSource = result.sourceNames.join(", ");
    state.edits = {};
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
    "Reset this tool to its initial data? This permanently deletes all browser-saved connector edits, QC notes, reviewed status, uploaded CC data, and custom layer order. Export anything you need first."
  );
  if (!confirmed) return;
  Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
  window.location.reload();
}

function shiftTaz(delta) {
  const next = Math.max(0, Math.min(state.tazOrder.length - 1, state.currentIndex + delta));
  goToTaz(state.tazOrder[next].id);
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
  rebuildGlobalConnectorIndex();
  updateHistoryButtons();
  renderQueue();
}

function editSnapshot() {
  return JSON.stringify(state.edits || {});
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
  state.edits = JSON.parse(snapshot || "{}");
  localStorage.setItem(STORAGE_KEYS.edits, JSON.stringify(state.edits));
  state.selected = null;
  state.pendingNode = null;
  state.contextConnector = null;
  state.dirty = false;
  hideContextMenu();
  rebuildGlobalConnectorIndex();
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
}

function setViewToAllData() {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const taz of state.data.tazs) {
    const item = geomBounds(taz.geom);
    bounds.minX = Math.min(bounds.minX, item.minX);
    bounds.maxX = Math.max(bounds.maxX, item.maxX);
    bounds.minY = Math.min(bounds.minY, item.minY);
    bounds.maxY = Math.max(bounds.maxY, item.maxY);
  }
  const pad = Math.max(2000, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.03);
  state.view = { minX: bounds.minX - pad, maxX: bounds.maxX + pad, minY: bounds.minY - pad, maxY: bounds.maxY + pad };
}

function showAllStatus() {
  status(`All data visible: ${state.data.tazs.length} TAZs, ${state.globalConnectors.length} CCs, ${state.data.nodes.length} nodes, ${state.data.links.length} GSTDM links`);
}

function zoomAll() {
  setViewToAllData();
  draw();
  showAllStatus();
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
  const spanX = state.view.maxX - state.view.minX;
  const spanY = state.view.maxY - state.view.minY;
  const scale = Math.min(state.width / spanX, state.height / spanY);
  return { scale, offsetX: (state.width - spanX * scale) / 2, offsetY: (state.height - spanY * scale) / 2 };
}

function project(xy) {
  const f = mapFrame();
  return { x: f.offsetX + (xy[0] - state.view.minX) * f.scale, y: f.offsetY + (state.view.maxY - xy[1]) * f.scale };
}

function unproject(pt) {
  const f = mapFrame();
  return [state.view.minX + (pt.x - f.offsetX) / f.scale, state.view.maxY - (pt.y - f.offsetY) / f.scale];
}

function visibleWorldBounds() {
  const topLeft = unproject({ x: 0, y: 0 });
  const bottomRight = unproject({ x: state.width, y: state.height });
  return { minX: topLeft[0], maxX: bottomRight[0], minY: bottomRight[1], maxY: topLeft[1] };
}

function zoomAt(x, y, factor) {
  if (!state.view) return;
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
  draw();
}

function panBy(dx, dy) {
  const f = mapFrame();
  const mx = -dx / f.scale;
  const my = dy / f.scale;
  state.view.minX += mx;
  state.view.maxX += mx;
  state.view.minY += my;
  state.view.maxY += my;
  draw();
}

function draw(mousePoint = null) {
  const ctx = state.ctx;
  ctx.clearRect(0, 0, state.width, state.height);
  if (state.basemap !== "none" && state.view) {
    drawBasemap();
  } else {
    ctx.fillStyle = "#f7f8fa";
    ctx.fillRect(0, 0, state.width, state.height);
    drawGrid();
  }
  if (!state.payload || !state.view) return;
  const globalScale = mapFrame().scale < 0.001;
  const renderers = {
    allTaz: () => {
      drawAllTazPolygons(globalScale);
      const hovered = state.hoveredTazId ? state.tazById.get(state.hoveredTazId) : null;
      if (hovered) drawGeometry(hovered.geom, "rgba(255,145,35,0.24)", "#e66a00", 4.5);
      drawGeometry(state.payload.taz, "rgba(55,145,255,0.28)", "#075fc7", 5);
    },
    gstdm: drawGlobalLinks,
    majorNodes: () => drawNodes("major"),
    nonMajorNodes: () => drawNodes("nonmajor"),
    connectors: drawConnectors,
    centroids: drawCentroids,
    tazLabels: () => drawTazLabels(globalScale),
  };
  for (const layer of [...state.layerOrder].reverse()) {
    if (state.layers[layer]) renderers[layer]?.();
  }
  drawEndpoint(mousePoint);
}

function drawBasemap() {
  const ctx = state.ctx;
  ctx.fillStyle = state.basemap === "satellite" ? "#d5d8d2" : "#eef1f5";
  ctx.fillRect(0, 0, state.width, state.height);
  if (!window.proj4) {
    drawGrid();
    status("Basemap projection library did not load. Vector layers still work.");
    return;
  }
  const visible = visibleWorldBounds();
  const center = sourceToLonLat([(visible.minX + visible.maxX) / 2, (visible.minY + visible.maxY) / 2]);
  const feetPerPixel = 1 / mapFrame().scale;
  const metersPerPixel = feetPerPixel * FT_TO_M;
  const targetRes = 156543.03392 * Math.cos((center[1] * Math.PI) / 180);
  const z = clamp(Math.round(Math.log2(targetRes / metersPerPixel)), 3, state.basemap === "satellite" ? 18 : 19);
  const edgeSamples = [];
  for (let index = 0; index <= 8; index += 1) {
    const ratio = index / 8;
    const x = visible.minX + (visible.maxX - visible.minX) * ratio;
    const y = visible.minY + (visible.maxY - visible.minY) * ratio;
    edgeSamples.push([x, visible.minY], [x, visible.maxY], [visible.minX, y], [visible.maxX, y]);
  }
  const lonLatSamples = edgeSamples.map(sourceToLonLat);
  const lons = lonLatSamples.map((p) => p[0]);
  const lats = lonLatSamples.map((p) => p[1]);
  const nw = lonLatToTile(Math.min(...lons), Math.max(...lats), z);
  const se = lonLatToTile(Math.max(...lons), Math.min(...lats), z);
  const maxTile = 2 ** z - 1;
  for (let x = clamp(nw.x - 1, 0, maxTile); x <= clamp(se.x + 1, 0, maxTile); x++) {
    for (let y = clamp(nw.y - 1, 0, maxTile); y <= clamp(se.y + 1, 0, maxTile); y++) {
      drawTile(x, y, z);
    }
  }
}

function drawTile(x, y, z) {
  const img = getTileImage(x, y, z);
  if (!img || !img.complete || !img.naturalWidth) return;
  const divisions = mapFrame().scale < 0.002 ? 4 : 2;
  const sourceWidth = img.naturalWidth / divisions;
  const sourceHeight = img.naturalHeight / divisions;
  for (let col = 0; col < divisions; col += 1) {
    for (let row = 0; row < divisions; row += 1) {
      const left = x + col / divisions;
      const right = x + (col + 1) / divisions;
      const top = y + row / divisions;
      const bottom = y + (row + 1) / divisions;
      const nw = project(lonLatToSource(tileToLonLat(left, top, z)));
      const ne = project(lonLatToSource(tileToLonLat(right, top, z)));
      const sw = project(lonLatToSource(tileToLonLat(left, bottom, z)));
      const ctx = state.ctx;
      ctx.save();
      ctx.transform(ne.x - nw.x, ne.y - nw.y, sw.x - nw.x, sw.y - nw.y, nw.x, nw.y);
      ctx.drawImage(
        img,
        col * sourceWidth,
        row * sourceHeight,
        sourceWidth,
        sourceHeight,
        -0.003,
        -0.003,
        1.006,
        1.006
      );
      ctx.restore();
    }
  }
}

function drawAllTazPolygons(globalScale) {
  const fill = globalScale ? "rgba(55,125,215,0.09)" : "rgba(55,125,215,0.055)";
  const stroke = globalScale ? "rgba(22,91,177,0.88)" : "rgba(22,91,177,0.72)";
  const width = globalScale ? 2.25 : 2.75;
  for (const taz of state.data.tazs) drawGeometry(taz.geom, fill, stroke, width);
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

function getTileImage(x, y, z) {
  const key = `${state.basemap}:${z}:${x}:${y}`;
  if (state.tileCache.has(key)) return state.tileCache.get(key);
  const img = new Image();
  img.onload = () => {
    state.tileRetries.delete(key);
    draw();
  };
  img.onerror = () => {
    state.tileCache.delete(key);
    const retries = (state.tileRetries.get(key) || 0) + 1;
    state.tileRetries.set(key, retries);
    if (retries <= 2) setTimeout(() => getTileImage(x, y, z), retries * 600);
  };
  img.src =
    state.basemap === "satellite"
      ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
      : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
  state.tileCache.set(key, img);
  return img;
}

function sourceToLonLat(xy) {
  return proj4(SOURCE_PROJ, "WGS84", xy);
}

function lonLatToSource(xy) {
  return proj4("WGS84", SOURCE_PROJ, xy);
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
  };
}

function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
      ctx.fillStyle = n.eligible ? "rgba(42,168,118,0.4)" : "rgba(214,40,40,0.55)";
      ctx.fillRect(p.x - 0.6, p.y - 0.6, 1.2, 1.2);
    }
    return;
  }
  for (const n of visible) {
    const p = project([n.x, n.y]);
    if (p.x < -10 || p.x > state.width + 10 || p.y < -10 || p.y > state.height + 10) continue;
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

function drawCentroids() {
  const ctx = state.ctx;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const bounds = visibleWorldBounds();
  for (const centroid of state.data.centroids) {
    if (centroid.x < bounds.minX || centroid.x > bounds.maxX || centroid.y < bounds.minY || centroid.y > bounds.maxY) continue;
    const current = String(centroid.id) === String(state.payload.tazId);
    const p = project([centroid.x, centroid.y]);
    ctx.fillStyle = current ? "#111827" : "rgba(17,24,39,0.55)";
    ctx.font = current ? "28px Arial" : "14px Arial";
    ctx.fillText("*", p.x, p.y + 2);
  }
}

function drawGlobalLinks() {
  const bounds = visibleWorldBounds();
  const visible = querySpatialGrid(state.linkGrid, bounds).filter((link) => boundsIntersect(link._bounds, bounds));
  const ctx = state.ctx;
  ctx.save();
  ctx.strokeStyle = "rgba(12,12,12,0.9)";
  ctx.lineWidth = mapFrame().scale < 0.001 ? 1 : 2;
  const chunkSize = 4000;
  for (let start = 0; start < visible.length; start += chunkSize) {
    ctx.beginPath();
    for (const link of visible.slice(start, start + chunkSize)) traceLineGeometry(link.geom);
    ctx.stroke();
  }
  ctx.restore();
}

function traceLineGeometry(geometry) {
  if (!geometry) return;
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
  for (const coordinates of lines) {
    coordinates.forEach((xy, index) => {
      const point = project(xy);
      if (index === 0) state.ctx.moveTo(point.x, point.y);
      else state.ctx.lineTo(point.x, point.y);
    });
  }
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

function findNodeAt(pt) {
  let best = null;
  let bestDist = 13;
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

function nearestEligibleNode(pt) {
  let best = null;
  let bestDist = 24;
  for (const n of state.payload.nodes) {
    if (!n.eligible) continue;
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
  const links = querySpatialGrid(state.linkGrid, bounds).filter((link) => boundsIntersect(link._bounds, bounds));
  for (const link of links) {
    for (const [a, b] of geometryLineSegments(link.geom)) {
      if (segmentsMeetBeforeEndpoint(start, end, a, b)) return true;
    }
  }
  return false;
}

function connectorTargetValidation(node) {
  if (!node?.eligible) return "Major node is locked. Choose a non-major node (MAJOR_LEVEL 3/4/5).";
  const endpoint = [node.x, node.y];
  const outsideLength = segmentOutsideLength(state.payload.centroid, endpoint, state.payload.taz);
  if (outsideLength > 200.000001) return `Connector would extend ${outsideLength.toFixed(1)} ft outside the TAZ; maximum is 200 ft.`;
  if (connectorCrossesGstdm(state.payload.centroid, endpoint)) return "Connector would cross a GSTDM link before reaching the target node.";
  return "";
}

function findTazAt(pt) {
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
  state.contextConnector = c;
  state.pendingNode = null;
  state.dirty = false;
  updateInspector();
  draw();
}

function applyEditToNode(node) {
  if (!state.selected) {
    toast("Select a connector first.");
    return;
  }
  const validationError = connectorTargetValidation(node);
  if (validationError) {
    toast(validationError);
    return;
  }
  const tazId = state.payload.tazId;
  const geom = { type: "LineString", coordinates: [state.payload.centroid, [node.x, node.y]] };
  const edit = {
    nodeId: node.id,
    majorLevel: node.majorLevel,
    outsideLen: segmentOutsideLength(state.payload.centroid, [node.x, node.y], state.payload.taz),
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
  toast(`Saved ${state.selected.ccPt} to node ${node.id}.`);
}

function clearSelection() {
  state.selected = null;
  state.pendingNode = null;
  state.dirty = false;
  state.contextConnector = null;
  hideContextMenu();
  updateInspector();
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
  if (state.payload.connectors.length <= 1) {
    toast("Each TAZ must keep at least 1 connector.");
    return;
  }
  pushEditHistory();
  state.edits[tazId] ||= {};
  if (connector.status === "added" || connector.ccPt.includes("_ADD")) {
    state.edits[tazId].added = (state.edits[tazId].added || []).filter((item) => item.ccPt !== connector.ccPt);
  } else {
    state.edits[tazId].deleted ||= [];
    if (!state.edits[tazId].deleted.includes(connector.ccPt)) state.edits[tazId].deleted.push(connector.ccPt);
    if (state.edits[tazId].connectors) delete state.edits[tazId].connectors[connector.ccPt];
  }
  markTazEdited(tazId);
  state.payload.connectors = state.payload.connectors.filter((item) => item.ccPt !== connector.ccPt);
  state.selected = null;
  state.contextConnector = null;
  state.pendingNode = null;
  state.dirty = false;
  saveLocal();
  updateInspector();
  draw();
  toast(`Deleted ${connector.ccPt} in this browser.`);
}

function updateInspector() {
  const c = state.selected;
  const tazId = state.payload?.tazId || "";
  qs("currentTaz").textContent = state.payload?.tazId || "-";
  qs("ccPt").textContent = c?.ccPt || "Select a connector";
  qs("currentNode").textContent = c?.nodeId || "-";
  qs("newNode").textContent = state.pendingNode?.id || "-";
  qs("majorLevel").textContent = state.pendingNode?.majorLevel ?? c?.majorLevel ?? "-";
  qs("outsideLen").textContent = c?.outsideLen != null ? `${Number(c.outsideLen).toFixed(1)} ft` : "-";
  qs("lineNodeDist").textContent = c?.lineNodeDist != null ? `${Number(c.lineNodeDist).toFixed(1)} ft` : "-";
  qs("dirtyBadge").classList.toggle("hidden", !state.dirty);
  const noteKey = c ? `${tazId}:${c.ccPt}` : `${tazId}:TAZ`;
  if (noteKey !== state.inspectorNoteKey) {
    qs("qcNote").value = c?.note ?? state.edits[tazId]?.note ?? "";
    state.inspectorNoteKey = noteKey;
  }
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
  }
}

function saveEdit() {
  if (!state.selected) {
    toast("Select a connector first.");
    return;
  }
  if (!state.pendingNode) {
    toast("Choose a new eligible node first.");
    return;
  }
  applyEditToNode(state.pendingNode);
}

function toggleAddMode() {
  if (!state.addMode && state.payload?.connectors.length >= 3) {
    toast("Each TAZ can have at most 3 connectors.");
    return;
  }
  state.addMode = !state.addMode;
  updateAddModeUi();
  toast(state.addMode ? "Tap an eligible node to add CC." : "Add CC off.");
}

function updateAddModeUi() {
  const btn = qs("addCcBtn");
  btn.classList.toggle("active", state.addMode);
  btn.textContent = state.addMode ? "Adding CC..." : "Add CC";
}

function addConnector(node) {
  if (state.payload.connectors.length >= 3) {
    toast("Each TAZ can have at most 3 connectors.");
    return;
  }
  const validationError = connectorTargetValidation(node);
  if (validationError) {
    toast(validationError);
    return;
  }
  const tazId = state.payload.tazId;
  pushEditHistory();
  const count = (state.edits[tazId]?.added?.length || 0) + 1;
  const connector = {
    ccPt: `${tazId}_ADD${count}`,
    nodeId: node.id,
    majorLevel: node.majorLevel,
    outsideLen: segmentOutsideLength(state.payload.centroid, [node.x, node.y], state.payload.taz),
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
  toast(`Added ${connector.ccPt}.`);
}

function markReviewed() {
  const tazId = state.payload.tazId;
  pushEditHistory();
  state.edits[tazId] ||= {};
  state.edits[tazId].qcStatus = "REVIEWED";
  delete state.edits[tazId].reviewed;
  state.edits[tazId].note = qs("qcNote").value;
  saveLocal();
  toast(`TAZ ${tazId} marked reviewed.`);
}

async function allConnectorsForExport() {
  const rows = [];
  for (const item of state.tazOrder) {
    const payload = basePayloadForTaz(item.id, false);
    applyImportedCc(payload);
    applySavedEdits(payload);
    const tazNote = state.edits[payload.tazId]?.note || "";
    for (const c of payload.connectors) rows.push({ A: payload.tazId, B: c.nodeId, FCLASS: 32, QC_NOTES: c.note ?? tazNote });
    for (const c of payload.importUnavailableRows || []) rows.push({ A: payload.tazId, B: c.nodeId, FCLASS: 32, QC_NOTES: c.note ?? tazNote });
  }
  return rows;
}

async function exportFinalCc() {
  const format = document.querySelector('input[name="exportFormat"]:checked')?.value || "dbf";
  const includeNotes = qs("includeQcNotes").checked;
  hideExportDialog();
  toast(`Preparing final CC ${format.toUpperCase()}${includeNotes ? " and QCNOTES" : ""}...`);
  const rows = [];
  const noteRows = [];
  for (const r of await allConnectorsForExport()) {
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
  status(`Exported ${rows.length} ${format.toUpperCase()} CC records${noteStatus}.`);
}

function tazQcStatusRows() {
  return state.tazOrder.map((item) => ({
    TAZ_ID: String(item.id),
    QC_STATUS: getTazStatus(item.id),
    QC_NOTES: state.edits[String(item.id)]?.note || "",
  }));
}

async function exportTazQcStatus() {
  const format = document.querySelector('input[name="tazStatusExportFormat"]:checked')?.value || "csv";
  hideTazStatusExportDialog();
  const rows = tazQcStatusRows();
  if (format === "csv") {
    downloadBlob(makeCsv(rows, ["TAZ_ID", "QC_STATUS", "QC_NOTES"]), "taz_qc_status.csv", "text/csv;charset=utf-8");
  } else {
    toast("Preparing TAZ QC Status Shapefile...");
    const features = rows.map((row) => ({ ...row, geom: state.tazById.get(row.TAZ_ID)?.geom }));
    downloadBlob(await makeTazStatusShapefile(features), "taz_qc_status_shapefile.zip", "application/zip");
  }
  status(`Exported ${rows.length} TAZ QC status records as ${format === "csv" ? "CSV" : "Shapefile ZIP"}.`);
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
    bytes[off + 11] = 67;
    bytes[off + 16] = field.len;
  });
  bytes[headerLen - 1] = 0x0d;
  rows.forEach((row, i) => {
    let off = headerLen + i * recordLen;
    bytes[off++] = 0x20;
    for (const field of fields) {
      const value = String(row[field.name] ?? "").replace(/[\r\n\t]+/g, " ");
      if (encoding === "utf8") writeUtf8Padded(bytes, off, value, field.len);
      else writeAscii(bytes, off, value.slice(0, field.len).padEnd(field.len, " "), field.len);
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
    { name: "QC_STATUS", len: 10 },
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
