const state = {
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  tazOrder: [],
  currentIndex: 0,
  currentTazId: null,
  allTaz: null,
  payload: null,
  selectedConnector: null,
  pendingNode: null,
  dirty: false,
  addMode: false,
  view: { minX: -85, maxX: -84, minY: 33, maxY: 34 },
  isPanning: false,
  isDraggingEndpoint: false,
  dragStart: null,
  activePointerId: null,
  touchPointers: new Map(),
  pinchGesture: null,
  lastTapAt: 0,
  basemap: "road",
  leafletMap: null,
  leafletLayers: {},
  activeLeafletLayer: null,
  drawPending: false,
  contextConnector: null,
  hoverFeature: null,
  hoveredNodeId: null,
  layers: {
    allTaz: true,
    context: true,
    here: false,
    gstdm: true,
    nodes: true,
    connectors: true,
  },
};

const SOURCE_PROJ =
  "+proj=lcc +lat_0=0 +lon_0=-83.5 +lat_1=31.4166666666667 +lat_2=34.2833333333333 +x_0=0 +y_0=0 +datum=NAD83 +units=us-ft +no_defs +type=crs";

function qs(id) {
  return document.getElementById(id);
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || response.statusText);
  return data;
}

function setStatus(text) {
  qs("statusText").textContent = text;
}

function initLeafletMap() {
  if (!window.L || !window.proj4) {
    setStatus("Leaflet or projection library did not load. Vector layers remain available.");
    return;
  }
  state.leafletMap = L.map("leafletMap", {
    attributionControl: false,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false,
    zoomSnap: 0.25,
  }).setView([33.75, -84.4], 8);
  state.leafletLayers = {
    road: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxNativeZoom: 19,
      maxZoom: 20,
      keepBuffer: 4,
      updateWhenIdle: false,
      attribution: "&copy; OpenStreetMap contributors",
    }),
    satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 18,
      maxZoom: 20,
      keepBuffer: 4,
      updateWhenIdle: false,
      attribution: "Tiles &copy; Esri",
    }),
  };
  state.leafletMap.on("move zoom resize", () => {
    syncViewFromLeaflet();
    scheduleDraw();
  });
  updateLeafletBasemap();
}

function updateLeafletBasemap() {
  if (!state.leafletMap) return;
  if (state.activeLeafletLayer) state.leafletMap.removeLayer(state.activeLeafletLayer);
  state.activeLeafletLayer = state.leafletLayers[state.basemap] || null;
  if (state.activeLeafletLayer) state.activeLeafletLayer.addTo(state.leafletMap);
  qs("leafletMap").style.background = state.basemap === "satellite" ? "#d5d8d2" : "#f6f8fb";
}

function syncLeafletToView() {
  if (!state.leafletMap || !state.view) return;
  state.leafletMap.invalidateSize(false);
  const corners = [
    [state.view.minX, state.view.minY],
    [state.view.minX, state.view.maxY],
    [state.view.maxX, state.view.minY],
    [state.view.maxX, state.view.maxY],
  ].map(sourceToLonLat).map(([lon, lat]) => L.latLng(lat, lon));
  state.leafletMap.fitBounds(L.latLngBounds(corners), { animate: false, padding: [0, 0] });
  syncViewFromLeaflet();
}

function syncViewFromLeaflet() {
  if (!state.leafletMap || !state.payload) return;
  const corners = [
    { x: 0, y: 0 },
    { x: state.width, y: 0 },
    { x: 0, y: state.height },
    { x: state.width, y: state.height },
  ].map(unproject);
  state.view = {
    minX: Math.min(...corners.map((point) => point[0])),
    maxX: Math.max(...corners.map((point) => point[0])),
    minY: Math.min(...corners.map((point) => point[1])),
    maxY: Math.max(...corners.map((point) => point[1])),
  };
}

function toast(text) {
  const el = qs("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 2400);
}

async function init() {
  state.canvas = qs("mapCanvas");
  state.ctx = state.canvas.getContext("2d");
  resizeCanvas();
  initLeafletMap();
  window.addEventListener("resize", () => {
    resizeCanvas();
    state.leafletMap?.invalidateSize(false);
    scheduleDraw();
  });
  bindCanvas();
  bindControls();

  const appState = await getJson("/api/state");
  updateHistoryButtons(appState);
  qs("runFolder").textContent = appState.runFolder;
  state.tazOrder = sortTazOrder(appState.tazOrder);
  renderQueue();
  state.allTaz = await getJson("/api/all-taz");
  if (appState.firstTaz) await goToTaz(appState.firstTaz);
}

async function refreshQueueState() {
  const appState = await getJson("/api/state");
  updateHistoryButtons(appState);
  state.tazOrder = sortTazOrder(appState.tazOrder);
  const index = state.tazOrder.findIndex((item) => String(item.id) === String(state.currentTazId));
  if (index >= 0) state.currentIndex = index;
  renderQueue();
}

function resizeCanvas() {
  const rect = state.canvas.parentElement.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  state.width = Math.max(100, Math.floor(rect.width));
  state.height = Math.max(100, Math.floor(rect.height));
  state.canvas.width = Math.floor(state.width * scale);
  state.canvas.height = Math.floor(state.height * scale);
  state.canvas.style.width = `${state.width}px`;
  state.canvas.style.height = `${state.height}px`;
  state.ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

function bindControls() {
  qs("prevBtn").addEventListener("click", () => shiftTaz(-1));
  qs("nextBtn").addEventListener("click", () => shiftTaz(1));
  qs("undoBtn").addEventListener("click", undoEdit);
  qs("redoBtn").addEventListener("click", redoEdit);
  qs("saveBtn").addEventListener("click", saveEdit);
  qs("addCcBtn").addEventListener("click", toggleAddMode);
  qs("reviewedBtn").addEventListener("click", markReviewed);
  qs("jumpBtn").addEventListener("click", () => goToTaz(qs("jumpInput").value.trim()));
  qs("cubeBtn").addEventListener("click", showCubePath);
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
  document.addEventListener("click", (event) => {
    if (!qs("ccContextMenu").contains(event.target)) hideContextMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!qs("ccContextMenu").contains(event.target)) hideContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
      hideInstructions();
    }
  });
  qs("queueFilter").addEventListener("change", renderQueue);
  qs("basemapSelect").addEventListener("change", () => {
    state.basemap = qs("basemapSelect").value;
    updateLeafletBasemap();
    updateBasemapAttribution();
    scheduleDraw();
  });
  updateBasemapAttribution();
  document.querySelectorAll(".legend input").forEach((input) => {
    input.addEventListener("change", async () => {
      state.layers[input.dataset.layer] = input.checked;
      document.querySelectorAll(`.legend input[data-layer="${input.dataset.layer}"]`).forEach((peer) => {
        peer.checked = input.checked;
      });
      if (input.dataset.layer === "here" && input.checked && state.currentTazId) {
        await goToTaz(state.currentTazId, { keepView: true });
        return;
      }
      draw();
    });
  });
}

function showInstructions() {
  qs("instructionsPanel").classList.remove("hidden");
}

function hideInstructions() {
  qs("instructionsPanel").classList.add("hidden");
}

function bindCanvas() {
  state.canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const pt = eventPoint(event);
    const connector = findConnectorAt(pt) || state.selectedConnector;
    if (!connector) {
      hideContextMenu();
      return;
    }
    selectConnector(connector);
    showContextMenu(event.clientX, event.clientY, connector);
  });
  state.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 0.82 : 1.22;
    zoomAt(event.offsetX, event.offsetY, factor);
  });
  state.canvas.addEventListener("dblclick", (event) => {
    const pt = eventPoint(event);
    zoomAt(pt.x, pt.y, 0.72);
  });
  state.canvas.addEventListener("pointerdown", (event) => {
    hideContextMenu();
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
    state.activePointerId = event.pointerId;
    state.canvas.setPointerCapture(event.pointerId);
    if (state.selectedConnector && endpointHit(pt)) {
      state.isDraggingEndpoint = true;
      state.canvas.classList.add("dragging");
      event.preventDefault();
      return;
    }
    const nodeHitRadius = event.pointerType === "touch" ? 30 : state.selectedConnector ? 18 : 12;
    const node = findNodeAt(pt, nodeHitRadius);
    if (node && state.addMode) {
      addConnectorToNode(node);
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
    if (node && state.selectedConnector) {
      saveConnectorToNode(node);
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
      const node = nearestEligibleNode(pt);
      state.pendingNode = node;
      updateInspector(state.selectedConnector.properties);
      draw(pt);
      event.preventDefault();
      return;
    }
    if (state.isPanning && state.dragStart) {
      panBy(pt.x - state.dragStart.x, pt.y - state.dragStart.y);
      state.dragStart = pt;
      hideFeatureTooltip();
      event.preventDefault();
      return;
    }
    if (event.pointerType === "mouse") updateHover(pt);
  });
  state.canvas.addEventListener("mouseleave", () => {
    hideFeatureTooltip();
    updateHoveredCandidateNode(null);
  });
  state.canvas.addEventListener("pointerup", finishPointerGesture);
  state.canvas.addEventListener("pointercancel", finishPointerGesture);
}

function eventPoint(event) {
  const rect = state.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
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

function finishPointerGesture(event) {
  if (event.pointerType === "touch") {
    state.touchPointers.delete(event.pointerId);
    if (state.pinchGesture) {
      state.pinchGesture = state.touchPointers.size >= 2 ? touchPairMetrics() : null;
      state.activePointerId = state.touchPointers.size === 1 ? state.touchPointers.keys().next().value : null;
      state.isDraggingEndpoint = false;
      state.isPanning = false;
      state.dragStart = null;
      state.canvas.classList.remove("dragging", "panning");
      if (event.pointerId !== undefined && state.canvas.hasPointerCapture(event.pointerId)) state.canvas.releasePointerCapture(event.pointerId);
      return;
    }
  }
  if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;
    if (state.isDraggingEndpoint) {
      if (state.pendingNode) {
        saveConnectorToNode(state.pendingNode);
      } else {
        toast("No eligible node near endpoint.");
      }
      state.isDraggingEndpoint = false;
      state.canvas.classList.remove("dragging");
      updateInspector(state.selectedConnector.properties);
      draw();
    }
    state.isPanning = false;
    state.dragStart = null;
    state.activePointerId = null;
    state.canvas.classList.remove("panning");
    state.canvas.classList.remove("dragging");
    if (event.pointerId !== undefined && state.canvas.hasPointerCapture(event.pointerId)) {
      state.canvas.releasePointerCapture(event.pointerId);
    }
}

function sortTazOrder(items) {
  return [...items].sort((left, right) => {
    const leftNumber = Number(left.id);
    const rightNumber = Number(right.id);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
    return String(left.id).localeCompare(String(right.id), undefined, { numeric: true, sensitivity: "base" });
  });
}

function renderQueue({ revealCurrent = false } = {}) {
  const list = qs("queueList");
  const currentId = String(state.currentTazId ?? "");
  if (revealCurrent && currentId) qs("queueFilter").value = "all";
  const filter = qs("queueFilter").value;
  list.innerHTML = "";
  let activeRow = null;
  state.tazOrder
    .filter((item) => {
      if (filter !== "all") return item.queueStatus === filter;
      return true;
    })
    .forEach((item) => {
      const row = document.createElement("div");
      const isCurrent = String(item.id) === currentId;
      row.className = `queue-item ${isCurrent ? "active" : ""}`;
      row.dataset.tazId = String(item.id);
      if (isCurrent) activeRow = row;
      const status = queueStatusDisplay(item);
      row.innerHTML = `
        <div><strong>${item.id}</strong><br><small>${item.issue || "Ready"} | ${item.connectors} CC</small></div>
        <span class="pill ${status.className}">${status.label}</span>
      `;
      row.addEventListener("click", () => goToTaz(item.id));
      list.appendChild(row);
    });
  if (revealCurrent && activeRow) activeRow.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function queueStatusDisplay(item) {
  if (item.queueStatus === "flag_no_cc") return { label: "FLAG", className: "flag" };
  if (item.queueStatus === "edited") return { label: "EDITED", className: "edited" };
  if (item.queueStatus === "reviewed") return { label: "REVIEWED", className: "reviewed" };
  return { label: "WAITING FOR QC", className: "waiting-for-qc" };
}

async function goToTaz(id, options = {}) {
  if (!id) return;
  if (state.dirty && !confirm("Current edit is not saved. Continue without saving?")) return;
  const index = state.tazOrder.findIndex((item) => String(item.id) === String(id));
  if (index >= 0) state.currentIndex = index;
  state.currentTazId = String(id);
  clearSelection();
  setStatus(`Loading TAZ ${id}...`);
  state.payload = await getJson(
    `/api/taz/${encodeURIComponent(id)}?here=${state.layers.here ? "1" : "0"}`
  );
  if (!options.keepView) setViewToFeatureCollection(state.payload.context);
  qs("currentTaz").textContent = id;
  qs("jumpInput").value = id;
  renderQueue({ revealCurrent: true });
  draw();
  const currentCount = state.payload.connectors.features.length;
  const nearbyCount = state.payload.neighborConnectors?.features?.length || 0;
  setStatus(`TAZ ${id}: ${currentCount} connector(s), ${nearbyCount} nearby connector(s) within 1.5 mi`);
}

function shiftTaz(delta) {
  const next = Math.max(0, Math.min(state.tazOrder.length - 1, state.currentIndex + delta));
  goToTaz(state.tazOrder[next].id);
}

function setViewToFeatureCollection(collection) {
  const bounds = geojsonBounds(collection);
  if (!bounds) return;
  const dx = bounds.maxX - bounds.minX;
  const dy = bounds.maxY - bounds.minY;
  const padX = dx * 0.06 || 0.01;
  const padY = dy * 0.06 || 0.01;
  state.view = {
    minX: bounds.minX - padX,
    maxX: bounds.maxX + padX,
    minY: bounds.minY - padY,
    maxY: bounds.maxY + padY,
  };
  syncLeafletToView();
}

function draw(mousePoint = null) {
  const ctx = state.ctx;
  ctx.clearRect(0, 0, state.width, state.height);
  if (state.basemap === "none") {
    ctx.fillStyle = "#f6f8fb";
    ctx.fillRect(0, 0, state.width, state.height);
    drawGrid();
  }
  if (state.allTaz && state.layers.allTaz) {
    drawCollection(state.allTaz, { stroke: "#aab2bf", fill: "rgba(160,170,185,0.035)", width: 0.6 });
  }
  if (!state.payload) return;
  if (state.layers.context) {
    drawCollection(state.payload.context, { stroke: "#1769e0", fill: null, width: 1.2, dash: [6, 5] });
    drawCollection(state.payload.neighborTaz, { stroke: "#8b5cf6", fill: "rgba(139,92,246,0.10)", width: 1.4 });
  }
  if (state.layers.here) {
    drawCollection(state.payload.hereLinks, { stroke: "#aeb4bd", fill: null, width: 0.55, alpha: 0.72 });
  }
  if (state.layers.gstdm) {
    drawCollection(state.payload.gstdmLinks, { stroke: "#006b3f", fill: null, width: 2.0, alpha: 0.95 });
  }
  drawCollection(state.payload.currentTaz, { stroke: "#1769e0", fill: "rgba(127,186,255,0.32)", width: 3 });
  if (state.layers.connectors) drawConnectors();
  drawCentroid();
  if (state.layers.nodes) drawNodes();
  if (state.layers.context) drawNeighborTazLabels();
  drawCurrentTazLabel();
  drawEndpoint(mousePoint);
}

function scheduleDraw() {
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

function sourceToLonLat(xy) {
  return proj4(SOURCE_PROJ, "WGS84", xy);
}

function lonLatToSource(xy) {
  return proj4("WGS84", SOURCE_PROJ, xy);
}

function drawGrid() {
  const ctx = state.ctx;
  ctx.strokeStyle = "#e4e8ef";
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

function drawCollection(collection, style) {
  const ctx = state.ctx;
  ctx.save();
  ctx.globalAlpha = style.alpha ?? 1;
  ctx.setLineDash(style.dash || []);
  ctx.lineWidth = style.width || 1;
  ctx.strokeStyle = style.stroke || "#333";
  ctx.fillStyle = style.fill || "transparent";
  for (const feature of collection.features || []) {
    drawGeometry(feature.geometry, Boolean(style.fill));
  }
  ctx.restore();
}

function drawGeometry(geometry, fill) {
  if (!geometry) return;
  const type = geometry.type;
  if (type === "Polygon") drawPolygon(geometry.coordinates, fill);
  else if (type === "MultiPolygon") geometry.coordinates.forEach((part) => drawPolygon(part, fill));
  else if (type === "LineString") drawLine(geometry.coordinates);
  else if (type === "MultiLineString") geometry.coordinates.forEach(drawLine);
}

function drawPolygon(rings, fill) {
  const ctx = state.ctx;
  ctx.beginPath();
  rings.forEach((ring) => ring.forEach((coord, index) => {
    const p = project(coord);
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }));
  if (fill) ctx.fill("evenodd");
  ctx.stroke();
}

function drawLine(coords) {
  if (!coords || coords.length < 2) return;
  const ctx = state.ctx;
  ctx.beginPath();
  coords.forEach((coord, index) => {
    const p = project(coord);
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}

function drawConnectors() {
  const ctx = state.ctx;
  for (const feature of state.payload.neighborConnectors?.features || []) {
    ctx.save();
    ctx.strokeStyle = feature.properties.QC_STATUS === "edited" ? "#7c3aed" : "#f59e0b";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([8, 4]);
    drawGeometry(feature.geometry, false);
    ctx.restore();
  }
  for (const feature of state.payload.connectors.features || []) {
    const selected = state.selectedConnector && feature.properties.CC_PT === state.selectedConnector.properties.CC_PT;
    ctx.save();
    ctx.strokeStyle = selected ? "#ff8500" : feature.properties.QC_STATUS === "edited" ? "#8a2be2" : "#d62828";
    ctx.lineWidth = selected ? 4 : 2;
    drawGeometry(feature.geometry, false);
    ctx.restore();
  }
}

function drawNeighborTazLabels() {
  const ctx = state.ctx;
  ctx.save();
  ctx.font = "700 13px Segoe UI, Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const feature of state.payload.neighborTaz?.features || []) {
    const center = featureCenter(feature);
    const p = project(center);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(feature.properties.N || "", p.x, p.y);
    ctx.fillStyle = "#6d28d9";
    ctx.fillText(feature.properties.N || "", p.x, p.y);
  }
  ctx.restore();
}

function drawNodes() {
  const ctx = state.ctx;
  for (const feature of state.payload.nodes.features || []) {
    const coord = feature.geometry.coordinates;
    const p = project(coord);
    const eligible = feature.properties.SNAP_ELIG === true;
    const pending = state.pendingNode && state.pendingNode.properties.NODE_ID_TEXT === feature.properties.NODE_ID_TEXT;
    const hovered = Boolean(
      state.selectedConnector
      && eligible
      && String(feature.properties.NODE_ID_TEXT) === state.hoveredNodeId
    );
    ctx.beginPath();
    ctx.arc(p.x, p.y, hovered ? 10 : pending ? 8 : eligible ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = eligible ? "#2aa876" : "#d62828";
    ctx.fill();
    if (hovered) {
      ctx.lineWidth = 7;
      ctx.strokeStyle = "rgba(255,255,255,0.98)";
      ctx.stroke();
    }
    ctx.lineWidth = hovered ? 3 : pending ? 3 : 1.2;
    ctx.strokeStyle = hovered ? "#ff8500" : pending ? "#111827" : "#ffffff";
    ctx.stroke();
  }
}

function drawCentroid() {
  const feature = state.payload.centroid.features[0];
  if (!feature) return;
  const p = project(feature.geometry.coordinates);
  drawCentroidTriangle(state.ctx, p, 17);
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

function drawCurrentTazLabel() {
  const feature = state.payload.currentTaz.features[0];
  if (!feature) return;
  const center = featureCenter(feature);
  const p = project(center);
  const ctx = state.ctx;
  const label = state.currentTazId || feature.properties.N || "";
  ctx.save();
  ctx.font = "700 24px Segoe UI, Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.strokeText(label, p.x, p.y);
  ctx.fillStyle = "#1769e0";
  ctx.fillText(label, p.x, p.y);
  ctx.restore();
}

function drawEndpoint(mousePoint = null) {
  if (!state.selectedConnector) return;
  const p = mousePoint || endpointPoint();
  const ctx = state.ctx;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ff8500";
  ctx.stroke();
}

function project(coord) {
  if (state.leafletMap) {
    const [lon, lat] = sourceToLonLat(coord);
    const point = state.leafletMap.latLngToContainerPoint([lat, lon]);
    return { x: point.x, y: point.y };
  }
  const frame = mapFrame();
  const x = frame.offsetX + (coord[0] - state.view.minX) * frame.scale;
  const y = frame.offsetY + (state.view.maxY - coord[1]) * frame.scale;
  return { x, y };
}

function unproject(point) {
  if (state.leafletMap) {
    const latLng = state.leafletMap.containerPointToLatLng(L.point(point.x, point.y));
    return lonLatToSource([latLng.lng, latLng.lat]);
  }
  const frame = mapFrame();
  const x = state.view.minX + (point.x - frame.offsetX) / frame.scale;
  const y = state.view.maxY - (point.y - frame.offsetY) / frame.scale;
  return [x, y];
}

function mapFrame() {
  if (state.leafletMap) {
    const center = { x: state.width / 2, y: state.height / 2 };
    const first = unproject(center);
    const second = unproject({ x: center.x + 100, y: center.y });
    const sourceDistance = Math.hypot(second[0] - first[0], second[1] - first[1]);
    return {
      scale: sourceDistance > 0 ? 100 / sourceDistance : 1,
      drawWidth: state.width,
      drawHeight: state.height,
      offsetX: 0,
      offsetY: 0,
    };
  }
  const spanX = state.view.maxX - state.view.minX;
  const spanY = state.view.maxY - state.view.minY;
  const scale = Math.min(state.width / spanX, state.height / spanY);
  const drawWidth = spanX * scale;
  const drawHeight = spanY * scale;
  return {
    scale,
    drawWidth,
    drawHeight,
    offsetX: (state.width - drawWidth) / 2,
    offsetY: (state.height - drawHeight) / 2,
  };
}

function zoomAt(x, y, factor) {
  if (state.leafletMap) {
    const zoomDelta = Math.log2(1 / factor);
    state.leafletMap.setZoomAround(L.point(x, y), state.leafletMap.getZoom() + zoomDelta);
    syncViewFromLeaflet();
    draw();
    return;
  }
  const before = unproject({ x, y });
  const frame = mapFrame();
  const width = (state.view.maxX - state.view.minX) * factor;
  const height = (state.view.maxY - state.view.minY) * factor;
  const rx = Math.max(0, Math.min(1, (x - frame.offsetX) / frame.drawWidth));
  const ry = Math.max(0, Math.min(1, (y - frame.offsetY) / frame.drawHeight));
  state.view.minX = before[0] - width * rx;
  state.view.maxX = state.view.minX + width;
  state.view.maxY = before[1] + height * ry;
  state.view.minY = state.view.maxY - height;
  draw();
}

function panBy(dx, dy) {
  if (state.leafletMap) {
    state.leafletMap.panBy(L.point(-dx, -dy), { animate: false });
    syncViewFromLeaflet();
    scheduleDraw();
    return;
  }
  const frame = mapFrame();
  const moveX = -dx / frame.scale;
  const moveY = dy / frame.scale;
  state.view.minX += moveX;
  state.view.maxX += moveX;
  state.view.minY += moveY;
  state.view.maxY += moveY;
  scheduleDraw();
}

function findConnectorAt(point) {
  let best = null;
  let bestDistance = 12;
  for (const feature of state.payload?.connectors.features || []) {
    const distance = distanceToFeature(point, feature.geometry);
    if (distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}

function findNodeAt(point, hitRadius = 12) {
  let best = null;
  let bestDistance = hitRadius;
  for (const feature of state.payload?.nodes.features || []) {
    if (feature.properties.SNAP_ELIG !== true) continue;
    const p = project(feature.geometry.coordinates);
    const distance = Math.hypot(point.x - p.x, point.y - p.y);
    if (distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestEligibleNode(point) {
  let best = null;
  let bestDistance = Infinity;
  for (const feature of state.payload?.nodes.features || []) {
    if (feature.properties.SNAP_ELIG !== true) continue;
    const p = project(feature.geometry.coordinates);
    const distance = Math.hypot(point.x - p.x, point.y - p.y);
    if (distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return bestDistance <= 60 ? best : null;
}

function updateHover(point) {
  if (!state.payload) return;
  const candidate = state.selectedConnector ? findEligibleNodeAt(point, 18) : null;
  updateHoveredCandidateNode(candidate);
  const hit = candidate
    ? { type: "Non-Major Node", feature: candidate }
    : findHoverFeature(point);
  if (!hit) {
    hideFeatureTooltip();
    return;
  }
  showFeatureTooltip(hit, point);
}

function updateHoveredCandidateNode(feature) {
  const nextId = feature ? String(feature.properties.NODE_ID_TEXT) : null;
  if (nextId === state.hoveredNodeId) return;
  state.hoveredNodeId = nextId;
  scheduleDraw();
}

function findHoverFeature(point) {
  const node = findAnyNodeAt(point);
  if (node) {
    return {
      type: node.properties.SNAP_ELIG === true ? "Non-Major Node" : "Major Node",
      feature: node,
    };
  }
  const connector = findConnectorAt(point);
  if (connector) return { type: "TAZ CC", feature: connector };
  if (state.layers.gstdm) {
    const gstdm = findLineFeatureAt(point, state.payload.gstdmLinks.features || [], 8);
    if (gstdm) return { type: "GSTDM Link", feature: gstdm };
  }
  if (state.layers.here) {
    const here = findLineFeatureAt(point, state.payload.hereLinks.features || [], 7);
    if (here) return { type: "HERE Master Link", feature: here };
  }
  return null;
}

function findAnyNodeAt(point) {
  let best = null;
  let bestDistance = 10;
  for (const feature of state.payload?.nodes.features || []) {
    const p = project(feature.geometry.coordinates);
    const distance = Math.hypot(point.x - p.x, point.y - p.y);
    if (distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}

function findEligibleNodeAt(point, hitRadius = 18) {
  let best = null;
  let bestDistance = hitRadius;
  for (const feature of state.payload?.nodes.features || []) {
    if (feature.properties.SNAP_ELIG !== true) continue;
    const p = project(feature.geometry.coordinates);
    const distance = Math.hypot(point.x - p.x, point.y - p.y);
    if (distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}

function findLineFeatureAt(point, features, threshold) {
  let best = null;
  let bestDistance = threshold;
  for (const feature of features) {
    const distance = distanceToFeature(point, feature.geometry);
    if (distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}

function showFeatureTooltip(hit, point) {
  const tooltip = qs("featureTooltip");
  tooltip.innerHTML = featureTableHtml(hit.type, hit.feature.properties || {});
  const offset = 14;
  const maxLeft = Math.max(8, state.width - 340);
  const maxTop = Math.max(8, state.height - 340);
  tooltip.style.left = `${Math.max(8, Math.min(maxLeft, point.x + offset))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(maxTop, point.y + offset))}px`;
  tooltip.classList.remove("hidden");
}

function hideFeatureTooltip() {
  qs("featureTooltip").classList.add("hidden");
}

function featureTableHtml(title, properties) {
  const rows = Object.entries(properties)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 24)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join("");
  return `<strong>${escapeHtml(title)}</strong><table>${rows || "<tr><td>No attributes</td></tr>"}</table>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function distanceToFeature(point, geometry) {
  if (!geometry) return Infinity;
  if (geometry.type === "LineString") return distanceToLine(point, geometry.coordinates);
  if (geometry.type === "MultiLineString") return Math.min(...geometry.coordinates.map((line) => distanceToLine(point, line)));
  return Infinity;
}

function distanceToLine(point, coords) {
  let best = Infinity;
  for (let i = 1; i < coords.length; i += 1) {
    best = Math.min(best, distanceToSegment(point, project(coords[i - 1]), project(coords[i])));
  }
  return best;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function endpointPoint() {
  if (state.pendingNode) return project(state.pendingNode.geometry.coordinates);
  const coords = state.selectedConnector.geometry.coordinates;
  return project(coords[coords.length - 1]);
}

function endpointHit(point) {
  const p = endpointPoint();
  return Math.hypot(point.x - p.x, point.y - p.y) <= 14;
}

function selectConnector(feature) {
  state.selectedConnector = feature;
  state.contextConnector = feature;
  state.pendingNode = null;
  state.hoveredNodeId = null;
  state.dirty = false;
  updateInspector(feature.properties);
  draw();
}

async function saveConnectorToNode(feature) {
  if (!state.selectedConnector || !feature) return;
  const ccPt = state.selectedConnector.properties.CC_PT;
  const nodeId = feature.properties.NODE_ID_TEXT;
  try {
    const result = await getJson("/api/save-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ccPt,
        nodeId,
        note: qs("qcNote").value,
      }),
    });
    updateHistoryButtons(result);
    state.pendingNode = null;
    state.dirty = false;
    toast(`Saved ${ccPt} to node ${nodeId}.`);
    await refreshQueueState();
    await goToTaz(state.currentTazId, { keepView: true });
  } catch (error) {
    toast(error.message);
  }
}

function toggleAddMode() {
  state.addMode = !state.addMode;
  if (state.addMode) {
    clearSelection();
    toast("Add CC mode: click an eligible node.");
  }
  updateAddModeUi();
}

function updateAddModeUi() {
  const button = qs("addCcBtn");
  button.classList.toggle("active", state.addMode);
  button.textContent = state.addMode ? "Adding CC..." : "Add CC";
}

async function addConnectorToNode(feature) {
  const nodeId = feature.properties.NODE_ID_TEXT;
  try {
    const result = await getJson("/api/add-connector", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tazId: state.currentTazId,
        nodeId,
        note: qs("qcNote").value,
      }),
    });
    updateHistoryButtons(result);
    state.addMode = false;
    updateAddModeUi();
    toast(`Added CC to node ${nodeId}.`);
    await refreshQueueState();
    await goToTaz(state.currentTazId, { keepView: true });
  } catch (error) {
    toast(error.message);
  }
}

function updateInspector(props) {
  qs("ccPt").textContent = props.CC_PT || "-";
  qs("currentNode").textContent = props.CC_NODE || "-";
  qs("newNode").textContent = state.pendingNode ? state.pendingNode.properties.NODE_ID_TEXT : "-";
  qs("majorLevel").textContent = state.pendingNode ? state.pendingNode.properties.MAJOR_LEVEL : props.MAJOR_LEVEL ?? "-";
  qs("outsideLen").textContent = formatFeet(props.OUTSIDE_LEN);
  qs("endBoundaryDist").textContent = formatFeet(props.END_BND_DIST);
  qs("endpointType").textContent = props.INTERIOR_FALLBACK ? "INTERIOR FALLBACK" : "BOUNDARY-NEAR";
  qs("lineNodeDist").textContent = formatFeet(props.LINE_NODE_DIST);
  qs("qcNote").value = props.QC_NOTE || "";
  qs("dirtyBadge").classList.toggle("hidden", !state.dirty);
}

async function saveEdit() {
  if (!state.selectedConnector || !state.pendingNode) {
    toast("Select a connector and snap it to a new node first.");
    return;
  }
  await saveConnectorToNode(state.pendingNode);
}

async function markReviewed() {
  const result = await getJson("/api/mark-reviewed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tazId: state.currentTazId, note: qs("qcNote").value }),
  });
  updateHistoryButtons(result);
  toast("Marked reviewed.");
  await refreshQueueState();
  await goToTaz(state.currentTazId, { keepView: true });
}

async function deleteSelectedConnector() {
  const connector = state.contextConnector || state.selectedConnector;
  if (!connector) {
    toast("Right-click a connector first.");
    return;
  }
  const ccPt = connector.properties.CC_PT;
  const result = await getJson("/api/delete-connector", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ccPt }),
  });
  updateHistoryButtons(result);
  state.selectedConnector = null;
  state.contextConnector = null;
  state.pendingNode = null;
  state.dirty = false;
  toast(`Deleted ${ccPt}.`);
  await refreshQueueState();
  await goToTaz(state.currentTazId, { keepView: true });
}

async function undoEdit() {
  try {
    const result = await getJson("/api/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    updateHistoryButtons(result);
    toast("Edit undone.");
    await refreshQueueState();
    await goToTaz(state.currentTazId, { keepView: true });
  } catch (error) {
    toast(error.message);
  }
}

async function redoEdit() {
  try {
    const result = await getJson("/api/redo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    updateHistoryButtons(result);
    toast("Edit redone.");
    await refreshQueueState();
    await goToTaz(state.currentTazId, { keepView: true });
  } catch (error) {
    toast(error.message);
  }
}

function updateHistoryButtons(payload = {}) {
  qs("undoBtn").disabled = !payload.canUndo;
  qs("redoBtn").disabled = !payload.canRedo;
}

async function showCubePath() {
  const payload = await getJson("/api/export-cube");
  toast(`Cube DBF: ${payload.path}`);
}

function clearSelection() {
  state.selectedConnector = null;
  state.pendingNode = null;
  state.hoveredNodeId = null;
  state.contextConnector = null;
  state.dirty = false;
  hideContextMenu();
  qs("ccPt").textContent = "Select a connector";
  qs("currentNode").textContent = "-";
  qs("newNode").textContent = "-";
  qs("majorLevel").textContent = "-";
  qs("outsideLen").textContent = "-";
  qs("endBoundaryDist").textContent = "-";
  qs("endpointType").textContent = "-";
  qs("lineNodeDist").textContent = "-";
  qs("dirtyBadge").classList.add("hidden");
  if (state.payload) draw();
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

function geojsonBounds(collection) {
  let bounds = null;
  for (const feature of collection.features || []) {
    scanCoords(feature.geometry?.coordinates, (coord) => {
      if (!bounds) bounds = { minX: coord[0], maxX: coord[0], minY: coord[1], maxY: coord[1] };
      bounds.minX = Math.min(bounds.minX, coord[0]);
      bounds.maxX = Math.max(bounds.maxX, coord[0]);
      bounds.minY = Math.min(bounds.minY, coord[1]);
      bounds.maxY = Math.max(bounds.maxY, coord[1]);
    });
  }
  return bounds;
}

function featureCenter(feature) {
  let bounds = null;
  scanCoords(feature.geometry?.coordinates, (coord) => {
    if (!bounds) bounds = { minX: coord[0], maxX: coord[0], minY: coord[1], maxY: coord[1] };
    bounds.minX = Math.min(bounds.minX, coord[0]);
    bounds.maxX = Math.max(bounds.maxX, coord[0]);
    bounds.minY = Math.min(bounds.minY, coord[1]);
    bounds.maxY = Math.max(bounds.maxY, coord[1]);
  });
  if (!bounds) return [0, 0];
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

function scanCoords(value, fn) {
  if (!value) return;
  if (typeof value[0] === "number") fn(value);
  else value.forEach((item) => scanCoords(item, fn));
}

function formatFeet(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${numeric.toFixed(1)} ft`;
}

init().catch((error) => {
  console.error(error);
  setStatus(error.message);
  toast(error.message);
});
