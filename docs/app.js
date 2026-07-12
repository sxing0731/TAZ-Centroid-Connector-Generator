const state = {
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  index: null,
  tazOrder: [],
  currentIndex: 0,
  payload: null,
  cache: new Map(),
  selected: null,
  pendingNode: null,
  dirty: false,
  addMode: false,
  view: null,
  dragStart: null,
  isPanning: false,
  isDraggingEndpoint: false,
  activePointerId: null,
  lastTapAt: 0,
  basemap: "road",
  tileCache: new Map(),
  layers: { allTaz: true, gstdm: true, nodes: true, connectors: true },
  edits: JSON.parse(localStorage.getItem("tazQaqcEdits") || "{}"),
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

  state.index = await fetchJson("data/index.json");
  state.tazOrder = state.index.tazOrder;
  qs("runFolder").textContent = `${state.index.generatedFrom} | ${state.index.count} TAZs`;
  renderQueue();
  await goToTaz(state.tazOrder[0].id);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

function bindControls() {
  qs("prevBtn").addEventListener("click", () => shiftTaz(-1));
  qs("nextBtn").addEventListener("click", () => shiftTaz(1));
  qs("jumpBtn").addEventListener("click", () => goToTaz(qs("jumpInput").value.trim()));
  qs("saveBtn").addEventListener("click", saveEdit);
  qs("addCcBtn").addEventListener("click", toggleAddMode);
  qs("reviewedBtn").addEventListener("click", markReviewed);
  qs("cubeBtn").addEventListener("click", exportCubeDbf);
  qs("clearBtn").addEventListener("click", clearSelection);
  qs("queueFilter").addEventListener("change", renderQueue);
  qs("basemapSelect").addEventListener("change", () => {
    state.basemap = qs("basemapSelect").value;
    draw();
  });
  document.querySelectorAll(".legend input").forEach((input) => {
    input.addEventListener("change", () => {
      state.layers[input.dataset.layer] = input.checked;
      document.querySelectorAll(`.legend input[data-layer="${input.dataset.layer}"]`).forEach((peer) => {
        peer.checked = input.checked;
      });
      draw();
    });
  });
}

function bindCanvas() {
  state.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(event.offsetX, event.offsetY, event.deltaY < 0 ? 0.82 : 1.22);
  });
  state.canvas.addEventListener("dblclick", (event) => {
    const pt = eventPoint(event);
    zoomAt(pt.x, pt.y, 0.72);
  });
  state.canvas.addEventListener("pointerdown", (event) => {
    const pt = eventPoint(event);
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
      state.pendingNode = nearestEligibleNode(pt);
      updateInspector();
      draw(pt);
      event.preventDefault();
      return;
    }
    if (state.isPanning && state.dragStart) {
      panBy(pt.x - state.dragStart.x, pt.y - state.dragStart.y);
      state.dragStart = pt;
      event.preventDefault();
    }
  });
  state.canvas.addEventListener("pointerup", finishPointer);
  state.canvas.addEventListener("pointercancel", finishPointer);
}

function finishPointer(event) {
  if (state.activePointerId !== null && event.pointerId !== state.activePointerId) return;
  if (state.isDraggingEndpoint) {
    if (state.pendingNode) {
      state.dirty = true;
      toast(`Pending snap to node ${state.pendingNode.id}`);
    } else {
      toast("No eligible non-major node near endpoint.");
    }
    updateInspector();
  }
  state.isDraggingEndpoint = false;
  state.isPanning = false;
  state.dragStart = null;
  state.activePointerId = null;
  state.canvas.classList.remove("dragging", "panning");
  if (event.pointerId !== undefined && state.canvas.hasPointerCapture(event.pointerId)) {
    state.canvas.releasePointerCapture(event.pointerId);
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

function renderQueue() {
  const filter = qs("queueFilter").value;
  const list = qs("queueList");
  list.innerHTML = "";
  state.tazOrder
    .filter((item) => {
      const edit = state.edits[item.id];
      if (filter === "flagged") return item.flag === "Y";
      if (filter === "edited") return edit?.status === "edited" || edit?.added?.length;
      if (filter === "reviewed") return edit?.reviewed;
      if (filter === "unreviewed") return !edit?.reviewed;
      return true;
    })
    .forEach((item) => {
      const edit = state.edits[item.id] || {};
      const row = document.createElement("div");
      row.className = `queue-item ${item.id === state.payload?.tazId ? "active" : ""}`;
      const pill = edit.reviewed ? "reviewed" : edit.status === "edited" || edit.added?.length ? "edited" : item.flag === "Y" ? "flag" : "";
      const label = edit.reviewed ? "REVIEWED" : edit.status === "edited" || edit.added?.length ? "EDITED" : item.flag === "Y" ? "FLAGGED" : "READY";
      row.innerHTML = `<div><strong>${item.id}</strong><br><small>${item.issue || "Ready"} | ${item.connectors} CC</small></div><span class="pill ${pill}">${label}</span>`;
      row.addEventListener("click", () => goToTaz(item.id));
      list.appendChild(row);
    });
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
  if (!state.cache.has(item.id)) state.cache.set(item.id, await fetchJson(item.file));
  state.payload = structuredClone(state.cache.get(item.id));
  applySavedEdits(state.payload);
  state.selected = null;
  state.pendingNode = null;
  state.dirty = false;
  qs("jumpInput").value = item.id;
  qs("currentTaz").textContent = item.id;
  if (!keepView) setViewToPayload();
  renderQueue();
  updateInspector();
  draw();
  status(`TAZ ${item.id}: ${state.payload.connectors.length} connector(s), ${state.payload.nodes.length} nodes, ${state.payload.links.length} GSTDM links`);
}

function shiftTaz(delta) {
  const next = Math.max(0, Math.min(state.tazOrder.length - 1, state.currentIndex + delta));
  goToTaz(state.tazOrder[next].id);
}

function applySavedEdits(payload) {
  const saved = state.edits[payload.tazId];
  if (!saved) return;
  for (const connector of payload.connectors) {
    const edit = saved.connectors?.[connector.ccPt];
    if (edit) Object.assign(connector, edit);
  }
  if (saved.added) payload.connectors.push(...saved.added);
}

function saveLocal() {
  localStorage.setItem("tazQaqcEdits", JSON.stringify(state.edits));
  renderQueue();
}

function setViewToPayload() {
  const bounds = geomBounds(state.payload.taz);
  for (const link of state.payload.links) expandBounds(bounds, geomBounds(link.geom));
  const pad = Math.max(1500, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.08);
  state.view = { minX: bounds.minX - pad, maxX: bounds.maxX + pad, minY: bounds.minY - pad, maxY: bounds.maxY + pad };
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

function expandBounds(a, b) {
  a.minX = Math.min(a.minX, b.minX);
  a.maxX = Math.max(a.maxX, b.maxX);
  a.minY = Math.min(a.minY, b.minY);
  a.maxY = Math.max(a.maxY, b.maxY);
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
  if (state.layers.allTaz) {
    for (const taz of state.index.allTaz) drawGeometry(taz.geom, "rgba(160,170,185,0.035)", "#aab2bf", 0.6);
  }
  if (state.layers.gstdm) for (const link of state.payload.links) drawGeometry(link.geom, null, "#006b3f", 1.6);
  drawGeometry(state.payload.taz, "rgba(127,186,255,0.32)", "#1769e0", 3);
  if (state.layers.connectors) drawConnectors();
  drawCentroid();
  if (state.layers.nodes) drawNodes();
  drawLabel();
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
  const center = sourceToLonLat([(state.view.minX + state.view.maxX) / 2, (state.view.minY + state.view.maxY) / 2]);
  const feetPerPixel = 1 / mapFrame().scale;
  const metersPerPixel = feetPerPixel * FT_TO_M;
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
  for (let x = clamp(nw.x, 0, maxTile); x <= clamp(se.x, 0, maxTile); x++) {
    for (let y = clamp(nw.y, 0, maxTile); y <= clamp(se.y, 0, maxTile); y++) {
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
  for (const c of state.payload.connectors) {
    const selected = state.selected?.ccPt === c.ccPt;
    drawGeometry(connectorGeom(c), null, selected ? "#ff8500" : c.status === "edited" || c.status === "added" ? "#8a2be2" : "#d62828", selected ? 3 : 1.4);
  }
}

function drawNodes() {
  const ctx = state.ctx;
  for (const n of state.payload.nodes) {
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

function drawCentroid() {
  const p = project(state.payload.centroid);
  const ctx = state.ctx;
  ctx.fillStyle = "#111827";
  ctx.font = "28px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("*", p.x, p.y + 2);
}

function drawLabel() {
  const p = project(state.payload.centroid);
  const ctx = state.ctx;
  ctx.fillStyle = "#1769e0";
  ctx.font = "700 24px Arial";
  ctx.textAlign = "center";
  ctx.fillText(state.payload.tazId, p.x, p.y - 54);
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

function selectConnector(c) {
  state.selected = c;
  state.pendingNode = null;
  state.dirty = false;
  updateInspector();
  draw();
}

function setPendingNode(n) {
  if (!n.eligible) {
    toast("Major node is locked. Choose MAJOR_LEVEL 4/5.");
    return;
  }
  state.pendingNode = n;
  state.dirty = true;
  updateInspector();
  draw();
}

function clearSelection() {
  state.selected = null;
  state.pendingNode = null;
  state.dirty = false;
  updateInspector();
  draw();
}

function updateInspector() {
  const c = state.selected;
  qs("currentTaz").textContent = state.payload?.tazId || "-";
  qs("ccPt").textContent = c?.ccPt || "Select a connector";
  qs("currentNode").textContent = c?.nodeId || "-";
  qs("newNode").textContent = state.pendingNode?.id || "-";
  qs("majorLevel").textContent = state.pendingNode?.majorLevel ?? c?.majorLevel ?? "-";
  qs("outsideLen").textContent = c?.outsideLen != null ? `${Number(c.outsideLen).toFixed(1)} ft` : "-";
  qs("lineNodeDist").textContent = c?.lineNodeDist != null ? `${Number(c.lineNodeDist).toFixed(1)} ft` : "-";
  qs("dirtyBadge").classList.toggle("hidden", !state.dirty);
}

function saveEdit() {
  if (!state.selected) {
    toast("Select a connector first.");
    return;
  }
  if (!state.pendingNode) {
    toast("Choose a new non-major node first.");
    return;
  }
  const tazId = state.payload.tazId;
  const geom = { type: "LineString", coordinates: [state.payload.centroid, [state.pendingNode.x, state.pendingNode.y]] };
  const edit = {
    nodeId: state.pendingNode.id,
    majorLevel: state.pendingNode.majorLevel,
    status: "edited",
    note: qs("qcNote").value,
    geom,
  };
  state.edits[tazId] ||= {};
  state.edits[tazId].connectors ||= {};
  state.edits[tazId].connectors[state.selected.ccPt] = edit;
  Object.assign(state.selected, edit);
  state.pendingNode = null;
  state.dirty = false;
  saveLocal();
  updateInspector();
  draw();
  toast("Saved in this browser.");
}

function toggleAddMode() {
  state.addMode = !state.addMode;
  updateAddModeUi();
  toast(state.addMode ? "Tap an eligible non-major node to add CC." : "Add CC off.");
}

function updateAddModeUi() {
  const btn = qs("addCcBtn");
  btn.classList.toggle("active", state.addMode);
  btn.textContent = state.addMode ? "Adding CC..." : "Add CC";
}

function addConnector(node) {
  if (!node.eligible) {
    toast("Cannot add CC to major node.");
    return;
  }
  const tazId = state.payload.tazId;
  const count = (state.edits[tazId]?.added?.length || 0) + 1;
  const connector = {
    ccPt: `${tazId}_ADD${count}`,
    nodeId: node.id,
    majorLevel: node.majorLevel,
    outsideLen: 0,
    lineNodeDist: 0,
    status: "added",
    geom: { type: "LineString", coordinates: [state.payload.centroid, [node.x, node.y]] },
  };
  state.payload.connectors.push(connector);
  state.edits[tazId] ||= {};
  state.edits[tazId].added ||= [];
  state.edits[tazId].added.push(connector);
  state.addMode = false;
  updateAddModeUi();
  saveLocal();
  selectConnector(connector);
  toast(`Added ${connector.ccPt}.`);
}

function markReviewed() {
  const tazId = state.payload.tazId;
  state.edits[tazId] ||= {};
  state.edits[tazId].reviewed = true;
  state.edits[tazId].note = qs("qcNote").value;
  saveLocal();
  toast(`TAZ ${tazId} marked reviewed.`);
}

async function allConnectorsForExport() {
  const rows = [];
  for (const item of state.tazOrder) {
    if (!state.cache.has(item.id)) state.cache.set(item.id, await fetchJson(item.file));
    const base = state.cache.get(item.id);
    const payload = structuredClone(base);
    applySavedEdits(payload);
    for (const c of payload.connectors) rows.push({ A: payload.tazId, B: c.nodeId, FCLASS: 32 });
  }
  return rows;
}

async function exportCubeDbf() {
  toast("Preparing Cube DBF for all TAZs...");
  const rows = [];
  for (const r of await allConnectorsForExport()) {
    rows.push(r, { A: r.B, B: r.A, FCLASS: 32 });
  }
  if (!rows.length) {
    toast("No loaded connectors to export yet.");
    return;
  }
  downloadBlob(makeDbf(rows), "cube_taz_cc_public.dbf", "application/octet-stream");
}

function makeDbf(rows) {
  const fields = [
    { name: "A", len: 20 },
    { name: "B", len: 20 },
    { name: "FCLASS", len: 8 },
  ];
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
      writeAscii(bytes, off, String(row[field.name] ?? "").slice(0, field.len).padEnd(field.len, " "), field.len);
      off += field.len;
    }
  });
  bytes[bytes.length - 1] = 0x1a;
  return new Blob([buffer]);
}

function writeAscii(bytes, offset, text, len) {
  for (let i = 0; i < len; i++) bytes[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
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
