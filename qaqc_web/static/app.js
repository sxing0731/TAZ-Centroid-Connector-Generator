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
  lastTapAt: 0,
  basemap: "road",
  tileCache: new Map(),
  contextConnector: null,
  hoverFeature: null,
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
const FT_TO_M = 0.3048006096012192;

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
  window.addEventListener("resize", () => {
    resizeCanvas();
    draw();
  });
  bindCanvas();
  bindControls();

  const appState = await getJson("/api/state");
  updateHistoryButtons(appState);
  qs("runFolder").textContent = appState.runFolder;
  state.tazOrder = appState.tazOrder;
  renderQueue();
  state.allTaz = await getJson("/api/all-taz");
  if (appState.firstTaz) await goToTaz(appState.firstTaz);
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
  qs("clearBtn").addEventListener("click", clearSelection);
  qs("ctxAddCcBtn").addEventListener("click", () => {
    hideContextMenu();
    state.addMode = true;
    updateAddModeUi();
    toast("Tap an eligible non-major node to add CC.");
  });
  qs("ctxDeleteCcBtn").addEventListener("click", () => {
    hideContextMenu();
    deleteSelectedConnector();
  });
  document.addEventListener("click", (event) => {
    if (!qs("ccContextMenu").contains(event.target)) hideContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideContextMenu();
  });
  qs("queueFilter").addEventListener("change", renderQueue);
  qs("basemapSelect").addEventListener("change", () => {
    state.basemap = qs("basemapSelect").value;
    draw();
  });
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
    const pt = eventPoint(event);
    state.activePointerId = event.pointerId;
    state.canvas.setPointerCapture(event.pointerId);
    if (state.selectedConnector && endpointHit(pt)) {
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
      addConnectorToNode(node);
      event.preventDefault();
      return;
    }
    if (node && state.selectedConnector) {
      setPendingNode(node);
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
  state.canvas.addEventListener("mouseleave", hideFeatureTooltip);
  state.canvas.addEventListener("pointerup", finishPointerGesture);
  state.canvas.addEventListener("pointercancel", finishPointerGesture);
}

function eventPoint(event) {
  const rect = state.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function finishPointerGesture(event) {
  if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;
    if (state.isDraggingEndpoint) {
      if (state.pendingNode) {
        state.dirty = true;
        toast(`Pending snap to node ${state.pendingNode.properties.NODE_ID_TEXT}`);
      } else {
        toast("No eligible non-major node near endpoint.");
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

function renderQueue() {
  const filter = qs("queueFilter").value;
  const list = qs("queueList");
  list.innerHTML = "";
  state.tazOrder
    .filter((item) => {
      if (filter === "flagged") return item.flag === "Y";
      return true;
    })
    .forEach((item) => {
      const row = document.createElement("div");
      row.className = `queue-item ${item.id === state.currentTazId ? "active" : ""}`;
      row.innerHTML = `
        <div><strong>${item.id}</strong><br><small>${item.issue || "Ready"} | ${item.connectors} CC</small></div>
        <span class="pill ${item.flag === "Y" ? "flag" : ""}">${item.flag === "Y" ? "FLAG" : "TAZ"}</span>
      `;
      row.addEventListener("click", () => goToTaz(item.id));
      list.appendChild(row);
    });
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
  renderQueue();
  draw();
  setStatus(`TAZ ${id}: ${state.payload.connectors.features.length} connector(s)`);
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
}

function draw(mousePoint = null) {
  const ctx = state.ctx;
  ctx.clearRect(0, 0, state.width, state.height);
  if (state.basemap !== "none" && state.view) {
    drawBasemap();
  } else {
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
  drawCurrentTazLabel();
  drawEndpoint(mousePoint);
}

function drawBasemap() {
  const ctx = state.ctx;
  ctx.fillStyle = state.basemap === "satellite" ? "#d5d8d2" : "#eef1f5";
  ctx.fillRect(0, 0, state.width, state.height);
  if (!window.proj4) {
    drawGrid();
    setStatus("Basemap projection library did not load. Vector layers still work.");
    return;
  }
  const center = sourceToLonLat([(state.view.minX + state.view.maxX) / 2, (state.view.minY + state.view.maxY) / 2]);
  const metersPerPixel = (1 / mapFrame().scale) * FT_TO_M;
  const targetRes = 156543.03392 * Math.cos((center[1] * Math.PI) / 180);
  const z = clamp(Math.round(Math.log2(targetRes / metersPerPixel)), 3, state.basemap === "satellite" ? 18 : 19);
  const corners = [
    sourceToLonLat([state.view.minX, state.view.minY]),
    sourceToLonLat([state.view.minX, state.view.maxY]),
    sourceToLonLat([state.view.maxX, state.view.minY]),
    sourceToLonLat([state.view.maxX, state.view.maxY]),
  ];
  const lons = corners.map((p) => p[0]);
  const lats = corners.map((p) => p[1]);
  const nw = lonLatToTile(Math.min(...lons), Math.max(...lats), z);
  const se = lonLatToTile(Math.max(...lons), Math.min(...lats), z);
  const maxTile = 2 ** z - 1;
  for (let x = clamp(nw.x, 0, maxTile); x <= clamp(se.x, 0, maxTile); x += 1) {
    for (let y = clamp(nw.y, 0, maxTile); y <= clamp(se.y, 0, maxTile); y += 1) {
      drawTile(x, y, z);
    }
  }
}

function drawTile(x, y, z) {
  const img = getTileImage(x, y, z);
  if (!img || !img.complete || !img.naturalWidth) return;
  const nw = lonLatToSource(tileToLonLat(x, y, z));
  const se = lonLatToSource(tileToLonLat(x + 1, y + 1, z));
  const p1 = project(nw);
  const p2 = project(se);
  const left = Math.min(p1.x, p2.x);
  const top = Math.min(p1.y, p2.y);
  const width = Math.abs(p2.x - p1.x);
  const height = Math.abs(p2.y - p1.y);
  if (width > 0 && height > 0) state.ctx.drawImage(img, left, top, width, height);
}

function getTileImage(x, y, z) {
  const key = `${state.basemap}:${z}:${x}:${y}`;
  if (state.tileCache.has(key)) return state.tileCache.get(key);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => draw();
  img.onerror = () => state.tileCache.set(key, null);
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
  for (const feature of state.payload.connectors.features || []) {
    const selected = state.selectedConnector && feature.properties.CC_PT === state.selectedConnector.properties.CC_PT;
    ctx.save();
    ctx.strokeStyle = selected ? "#ff8500" : feature.properties.QC_STATUS === "edited" ? "#8a2be2" : "#d62828";
    ctx.lineWidth = selected ? 4 : 2;
    drawGeometry(feature.geometry, false);
    ctx.restore();
  }
}

function drawNodes() {
  const ctx = state.ctx;
  for (const feature of state.payload.nodes.features || []) {
    const coord = feature.geometry.coordinates;
    const p = project(coord);
    const eligible = feature.properties.SNAP_ELIG === true;
    const pending = state.pendingNode && state.pendingNode.properties.NODE_ID_TEXT === feature.properties.NODE_ID_TEXT;
    ctx.beginPath();
    ctx.arc(p.x, p.y, pending ? 8 : eligible ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = eligible ? "#2aa876" : "#d62828";
    ctx.fill();
    ctx.lineWidth = pending ? 3 : 1.2;
    ctx.strokeStyle = pending ? "#111827" : "#ffffff";
    ctx.stroke();
  }
}

function drawCentroid() {
  const feature = state.payload.centroid.features[0];
  if (!feature) return;
  const p = project(feature.geometry.coordinates);
  const ctx = state.ctx;
  ctx.fillStyle = "#111827";
  ctx.font = "700 22px Segoe UI, Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("*", p.x, p.y);
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
  const frame = mapFrame();
  const x = frame.offsetX + (coord[0] - state.view.minX) * frame.scale;
  const y = frame.offsetY + (state.view.maxY - coord[1]) * frame.scale;
  return { x, y };
}

function unproject(point) {
  const frame = mapFrame();
  const x = state.view.minX + (point.x - frame.offsetX) / frame.scale;
  const y = state.view.maxY - (point.y - frame.offsetY) / frame.scale;
  return [x, y];
}

function mapFrame() {
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
  const frame = mapFrame();
  const moveX = -dx / frame.scale;
  const moveY = dy / frame.scale;
  state.view.minX += moveX;
  state.view.maxX += moveX;
  state.view.minY += moveY;
  state.view.maxY += moveY;
  draw();
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

function findNodeAt(point) {
  let best = null;
  let bestDistance = 12;
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
  const hit = findHoverFeature(point);
  if (!hit) {
    hideFeatureTooltip();
    return;
  }
  showFeatureTooltip(hit, point);
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
  state.dirty = false;
  updateInspector(feature.properties);
  draw();
}

function setPendingNode(feature) {
  state.pendingNode = feature;
  state.dirty = true;
  updateInspector(state.selectedConnector.properties);
  draw();
  toast(`Pending snap to node ${feature.properties.NODE_ID_TEXT}`);
}

function toggleAddMode() {
  state.addMode = !state.addMode;
  if (state.addMode) {
    clearSelection();
    toast("Add CC mode: click an eligible non-major node.");
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
  await goToTaz(state.currentTazId, { keepView: true });
}

function updateInspector(props) {
  qs("ccPt").textContent = props.CC_PT || "-";
  qs("currentNode").textContent = props.CC_NODE || "-";
  qs("newNode").textContent = state.pendingNode ? state.pendingNode.properties.NODE_ID_TEXT : "-";
  qs("majorLevel").textContent = state.pendingNode ? state.pendingNode.properties.MAJOR_LEVEL : props.MAJOR_LEVEL ?? "-";
  qs("outsideLen").textContent = formatFeet(props.OUTSIDE_LEN);
  qs("lineNodeDist").textContent = formatFeet(props.LINE_NODE_DIST);
  qs("qcNote").value = props.QC_NOTE || "";
  qs("dirtyBadge").classList.toggle("hidden", !state.dirty);
}

async function saveEdit() {
  if (!state.selectedConnector || !state.pendingNode) {
    toast("Select a connector and snap it to a new node first.");
    return;
  }
  const result = await getJson("/api/save-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ccPt: state.selectedConnector.properties.CC_PT,
      nodeId: state.pendingNode.properties.NODE_ID_TEXT,
      note: qs("qcNote").value,
    }),
  });
  updateHistoryButtons(result);
  state.dirty = false;
  toast("Saved.");
  await goToTaz(state.currentTazId);
}

async function markReviewed() {
  const result = await getJson("/api/mark-reviewed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tazId: state.currentTazId, note: qs("qcNote").value }),
  });
  updateHistoryButtons(result);
  toast("Marked reviewed.");
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
  state.contextConnector = null;
  state.dirty = false;
  hideContextMenu();
  qs("ccPt").textContent = "Select a connector";
  qs("currentNode").textContent = "-";
  qs("newNode").textContent = "-";
  qs("majorLevel").textContent = "-";
  qs("outsideLen").textContent = "-";
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
