const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const preview = {
  tazIds: ["1258", "1259", "1260", "1261", "1263"],
  index: 2,
  addMode: false,
};

function qs(id) {
  return document.getElementById(id);
}

function showToast(message) {
  const toast = qs("toast");
  toast.textContent = message;
  toast.style.display = "block";
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.textContent = "Public page is a static preview. Local QAQC runs at http://127.0.0.1:8765.";
  }, 2600);
}

function setCurrentTaz(index) {
  preview.index = Math.max(0, Math.min(preview.tazIds.length - 1, index));
  const taz = preview.tazIds[preview.index];
  qs("jumpInput").value = taz;
  document.querySelectorAll(".queue-item").forEach((item, itemIndex) => {
    item.classList.toggle("active", itemIndex === preview.index);
    if (itemIndex === preview.index) item.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  });
  document.querySelector(".inspector dd").textContent = taz;
  resize();
  showToast(`Preview TAZ ${taz}. Run locally for live data and saving.`);
}

function bindPreviewControls() {
  qs("prevBtn").addEventListener("click", () => setCurrentTaz(preview.index - 1));
  qs("nextBtn").addEventListener("click", () => setCurrentTaz(preview.index + 1));
  qs("jumpBtn").addEventListener("click", () => {
    const value = qs("jumpInput").value.trim();
    const index = preview.tazIds.indexOf(value);
    if (index >= 0) setCurrentTaz(index);
    else showToast(`TAZ ${value || "(blank)"} is not in this static sample.`);
  });
  qs("saveBtn").addEventListener("click", () => showToast("Save Edit requires the local Python QAQC server."));
  qs("reviewedBtn").addEventListener("click", () => showToast("Mark Reviewed requires the local Python QAQC server."));
  qs("cubeBtn").addEventListener("click", () => showToast("Cube DBF export is available in the local QAQC app."));
  qs("addCcBtn").addEventListener("click", () => {
    preview.addMode = !preview.addMode;
    qs("addCcBtn").classList.toggle("active", preview.addMode);
    qs("addCcBtn").textContent = preview.addMode ? "Adding CC..." : "Add CC";
    showToast(preview.addMode ? "Preview add mode. Local app lets you tap a non-major node." : "Add CC preview mode off.");
  });
  document.querySelectorAll(".queue-item").forEach((item, index) => {
    item.addEventListener("click", () => setCurrentTaz(index));
  });
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(rect.width, rect.height);
}

function line(points, color, width = 1, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.restore();
}

function dot(x, y, color, r = 5) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "white";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function draw(width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#dfe5ee";
  ctx.lineWidth = 1;
  for (let x = -40; x < width + 80; x += 64) line([[x, 0], [x + 120, height]], "#dfe5ee", 0.8);
  for (let y = 28; y < height; y += 72) line([[0, y], [width, y + 24]], "#e5e9f0", 0.8);

  const cx = width * 0.49;
  const cy = height * 0.54;
  const scale = Math.min(width, height) / 760;
  const poly = [
    [cx - 145 * scale, cy - 155 * scale],
    [cx - 38 * scale, cy - 220 * scale],
    [cx + 116 * scale, cy - 178 * scale],
    [cx + 188 * scale, cy - 62 * scale],
    [cx + 136 * scale, cy + 110 * scale],
    [cx - 12 * scale, cy + 185 * scale],
    [cx - 176 * scale, cy + 126 * scale],
    [cx - 226 * scale, cy - 28 * scale],
  ];

  ctx.save();
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = "rgba(127,186,255,0.32)";
  ctx.fill();
  ctx.strokeStyle = "#1769e0";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 305 * scale, 0, Math.PI * 2);
  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = "#1769e0";
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.restore();

  const hereRoads = [
    [[50, height * 0.22], [width * 0.55, height * 0.36], [width - 40, height * 0.34]],
    [[80, height * 0.72], [width * 0.46, height * 0.48], [width - 20, height * 0.56]],
    [[width * 0.34, 0], [width * 0.38, height]],
    [[width * 0.68, 0], [width * 0.63, height]],
  ];
  hereRoads.forEach((r) => line(r, "#aeb4bd", 1.1));

  const gstdmRoads = [
    [[20, height * 0.74], [width * 0.25, height * 0.58], [width * 0.54, height * 0.60], [width - 20, height * 0.42]],
    [[width * 0.30, 0], [width * 0.27, height * 0.33], [width * 0.38, height * 0.53], [width * 0.46, height]],
    [[width * 0.57, 0], [width * 0.54, height * 0.34], [width * 0.67, height]],
  ];
  gstdmRoads.forEach((r) => line(r, "#006b3f", 2.5));

  const targets = poly.slice(0, 7);
  targets.forEach(([x, y], i) => line([[cx, cy], [x, y]], i === 2 ? "#ff8500" : "#d62828", i === 2 ? 3 : 1.6));

  targets.forEach(([x, y], i) => dot(x, y, i % 3 === 0 ? "#e21b1b" : "#3b8f54", i % 3 === 0 ? 5.5 : 4.8));
  dot(cx + 162 * scale, cy + 38 * scale, "#1f78ff", 6);
  dot(cx - 94 * scale, cy - 118 * scale, "#1f78ff", 5);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = "#111";
  ctx.font = `${30 * scale}px Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("*", 0, 2);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "#1769e0";
  ctx.font = `700 ${Math.max(22, 34 * scale)}px Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(preview.tazIds[preview.index], cx, cy - 92 * scale);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "#ff8500";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx + 162 * scale, cy + 38 * scale, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

window.addEventListener("resize", resize);
bindPreviewControls();
resize();
