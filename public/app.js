const $ = id => document.getElementById(id);
const canvas = $("mapCanvas");
const ctx = canvas.getContext("2d");

let running = false;
let simulatedOffline = false;
let forceBunch = false;
let simTime = 0;
let buses = new Map();
let history = new Map();
let alerts = [];
let queueCount = 0;
let lastInp = "--";

const BUS_COUNT = 310;
const FIELDS = 8;
const workerCount = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
const routes = makeRoutes();
const routeIds = Object.keys(routes);
const routeIndex = Object.fromEntries(routeIds.map((r, i) => [r, i]));
const liveState = createLiveState();

const geoWorkers = Array.from({ length: workerCount }, (_, i) => {
  const w = new Worker("workers/geo-worker.js");
  w.onmessage = onGeo;
  return w;
});

let fleet = null;
try {
  fleet = new SharedWorker("workers/fleet-worker.js");
  fleet.port.start();
  fleet.port.onmessage = e => {
    if (e.data.type === "alerts") {
      alerts = e.data.payload;
      renderAlerts();
    }
  };
} catch (_) {
  $("alerts").innerHTML = "<span>SharedWorker no disponible en este navegador.</span>";
}

function makeRoutes() {
  const out = {};
  for (let r = 1; r <= 22; r++) {
    const id = `R${String(r).padStart(2, "0")}`;
    const pts = [];
    const baseLat = 1.2122 + (r % 6) * 0.00035;
    const baseLon = -77.2830 + Math.floor(r / 6) * 0.0009;
    for (let i = 0; i < 160; i++) {
      const t = i / 159;
      let lat = baseLat + 0.006 * t + Math.sin(t * 8 + r) * 0.00010;
      let lon = baseLon + 0.008 * t + Math.cos(t * 6 + r) * 0.00010;
      if (r % 4 === 0 && t > 0.38 && t < 0.66) lon += 0.00023;
      pts.push({ lat, lon });
    }
    out[id] = { id, points: pts };
  }
  return out;
}

function createLiveState() {
  const bytes = BUS_COUNT * FIELDS * Float64Array.BYTES_PER_ELEMENT * 2;
  const canUseSab = crossOriginIsolated && "SharedArrayBuffer" in window;
  const buffer = canUseSab ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  const versions = canUseSab ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2) : new ArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  return {
    shared: canUseSab,
    slot: 0,
    data: new Float64Array(buffer),
    versions: new Int32Array(versions)
  };
}

function publishLiveState() {
  const next = liveState.slot ? 0 : 1;
  const offset = next * BUS_COUNT * FIELDS;
  liveState.data.fill(0, offset, offset + BUS_COUNT * FIELDS);
  for (const b of buses.values()) {
    const i = offset + (b.bus - 1) * FIELDS;
    liveState.data[i] = b.bus;
    liveState.data[i + 1] = routeIndex[b.route] || 0;
    liveState.data[i + 2] = b.lat;
    liveState.data[i + 3] = b.lon;
    liveState.data[i + 4] = b.s;
    liveState.data[i + 5] = b.vel || 0;
    liveState.data[i + 6] = b.estimated ? 1 : 0;
    liveState.data[i + 7] = b.inService === false ? 0 : 1;
  }
  liveState.slot = next;
  if (liveState.shared) {
    Atomics.store(liveState.versions, 0, next);
    Atomics.add(liveState.versions, 1, 1);
  } else {
    liveState.versions[0] = next;
    liveState.versions[1]++;
  }
}

function readLiveRows() {
  const rows = [];
  while (true) {
    const before = liveState.shared ? Atomics.load(liveState.versions, 1) : liveState.versions[1];
    const slot = liveState.shared ? Atomics.load(liveState.versions, 0) : liveState.versions[0];
    const offset = slot * BUS_COUNT * FIELDS;
    for (let i = 0; i < BUS_COUNT; i++) {
      const p = offset + i * FIELDS;
      if (!liveState.data[p]) continue;
      rows.push({
        bus: liveState.data[p],
        route: routeIds[liveState.data[p + 1]] || "R01",
        lat: liveState.data[p + 2],
        lon: liveState.data[p + 3],
        s: liveState.data[p + 4],
        vel: liveState.data[p + 5],
        estimated: liveState.data[p + 6] === 1,
        inService: liveState.data[p + 7] !== 0
      });
    }
    const after = liveState.shared ? Atomics.load(liveState.versions, 1) : liveState.versions[1];
    if (before === after) return rows;
    rows.length = 0;
  }
}

function initWorkers() {
  geoWorkers.forEach((w, i) => w.postMessage({
    type: "init",
    payload: { routes, workerIndex: i, workerCount }
  }));
}

function onGeo(e) {
  if (e.data.type !== "matched") return;
  for (const b of e.data.payload) {
    buses.set(b.bus, b);
    if (!history.has(b.bus)) history.set(b.bus, []);
    const h = history.get(b.bus);
    h.push({ ...b, t: simTime });
    if (h.length > 7200) h.shift();
  }
  publishLiveState();
  saveLastState();
  fleet?.port.postMessage({ type: "matched", payload: e.data.payload });
  updateMetrics();
}

function generateFleet() {
  const arr = [];
  for (let i = 0; i < BUS_COUNT; i++) {
    const route = routeIds[i % routeIds.length];
    let s = (i * 137) % 8000;
    if (forceBunch && i < 12) s = 3500 + (i % 3) * 50;
    const p = pointAt(routes[route], s);
    arr.push({
      bus: i + 1,
      route,
      lat: p.lat,
      lon: p.lon,
      s,
      vel: 6 + (i % 5) * 0.5,
      hdop: 2 + (i % 5) * 0.6,
      inService: i % 17 !== 0,
      serverTs: Date.now(),
      ts: Date.now() - ((i % 11) * 8000)
    });
  }
  return arr;
}

function pointAt(route, s) {
  let acc = 0;
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1];
    const b = route.points[i];
    const len = Math.hypot((a.lat - b.lat) * 111000, (a.lon - b.lon) * 90000);
    if (acc + len >= s) {
      const t = (s - acc) / len;
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    acc += len;
  }
  return route.points[route.points.length - 1];
}

function dispatchGpsBatch(points) {
  for (let i = 0; i < geoWorkers.length; i++) {
    const part = points.filter(p => (routeIndex[p.route] % workerCount) === i);
    const packed = new Float64Array(part.length * 10);
    part.forEach((p, idx) => {
      const o = idx * 10;
      packed[o] = p.bus;
      packed[o + 1] = routeIndex[p.route];
      packed[o + 2] = p.lat;
      packed[o + 3] = p.lon;
      packed[o + 4] = p.vel || 0;
      packed[o + 5] = p.hdop || 0;
      packed[o + 6] = p.inService === false ? 0 : 1;
      packed[o + 7] = p.serverTs;
      packed[o + 8] = p.ts || p.serverTs;
      packed[o + 9] = p.reverse ? 1 : 0;
    });
    geoWorkers[i].postMessage({ type: "gpsPacked", payload: packed.buffer }, [packed.buffer]);
  }
}

function tick() {
  if (!running) return;
  simTime += 1;
  const points = [];
  let estimatedCount = 0;
  for (const b of buses.values()) {
    if (Math.random() < 0.015) continue;
    if (b.silenceUntil > simTime) {
      const estimatedS = b.s + (b.vel || 6);
      const p = pointAt(routes[b.route], estimatedS);
      const estimated = { ...b, s: estimatedS, lat: p.lat, lon: p.lon, estimated: true, serverTs: Date.now() };
      buses.set(b.bus, estimated);
      if (!history.has(b.bus)) history.set(b.bus, []);
      const h = history.get(b.bus);
      h.push({ ...estimated, t: simTime });
      if (h.length > 7200) h.shift();
      estimatedCount++;
      continue;
    }
    if (Math.random() < 0.01) b.silenceUntil = simTime + 40 + Math.round(Math.random() * 80);
    let s = b.s + (b.vel || 6);
    if (forceBunch && b.bus <= 12) s = 3500 + (b.bus % 3) * 50 + Math.sin(simTime / 3) * 12;
    const p = pointAt(routes[b.route], s);
    const hdop = Math.random() < 0.08 ? 7 : b.hdop;
    const jump = Math.random() < 0.05 ? 0.00045 : 0;
    points.push({
      ...b,
      lat: p.lat + (Math.random() - 0.5) * 0.00010 * (hdop / 3),
      lon: p.lon + (Math.random() - 0.5) * 0.00010 * (hdop / 3) + jump,
      s: undefined,
      hdop,
      inService: b.inService,
      serverTs: Date.now() - (Math.random() < 0.03 ? 12000 : 0),
      ts: Date.now() - ((b.bus % 11) * 8000)
    });
  }
  if (estimatedCount) publishLiveState();
  dispatchGpsBatch(points);
  setTimeout(tick, 1000);
}

function draw() {
  resizeCanvas();
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.fillStyle = "#f8fafb";
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.strokeStyle = "#b9c9b9";
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.clientWidth; x += 48) {
    const smallError = x % 96 === 0 ? 5 : 0;
    ctx.beginPath(); ctx.moveTo(x + smallError, 0); ctx.lineTo(x, canvas.clientHeight); ctx.stroke();
  }
  for (let y = 0; y < canvas.clientHeight; y += 48) {
    const smallError = y % 144 === 0 ? -4 : 0;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.clientWidth, y + smallError); ctx.stroke();
  }

  Object.values(routes).forEach((r, index) => {
    ctx.beginPath();
    r.points.forEach((p, i) => {
      const q = projectCanvas(p);
      i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
    });
    ctx.strokeStyle = index % 2 ? "#b9c6cf" : "#9eafb9";
    ctx.lineWidth = index % 2 ? 1 : 2;
    ctx.stroke();
  });

  const rows = getRowsForView();
  drawTrails(rows);
  rows.filter(inView).forEach(b => {
    const q = projectCanvas(b);
    const risk = alerts.some(a => a.bus === b.bus && a.type === "bunching");
    const size = b.inService ? 8 : 6;
    ctx.fillStyle = b.estimated ? "#7a63a8" : risk ? "#b73832" : "#277a4b";
    ctx.fillRect(q.x - size / 2, q.y - size / 2, size, size);
    ctx.fillStyle = "#20252b";
    ctx.font = "10px Arial";
    ctx.fillText(String(b.bus), q.x + 6, q.y + 3);
  });
  requestAnimationFrame(draw);
}

function getRowsForView() {
  const value = Number($("historyRange").value);
  if (value === 120) return readLiveRows();
  const target = simTime - ((120 - value) * 60);
  const rows = [];
  history.forEach(h => {
    let best = null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= target) { best = h[i]; break; }
    }
    if (best) rows.push({ ...best, estimated: true });
  });
  return rows;
}

function drawTrails(rows) {
  const showingLive = Number($("historyRange").value) === 120;
  if (!showingLive) return;
  ctx.strokeStyle = "#93a2b3";
  ctx.lineWidth = 1;
  for (const b of rows.slice(0, 80)) {
    const h = history.get(b.bus) || [];
    ctx.beginPath();
    h.filter(p => simTime - p.t <= 180).forEach((p, i) => {
      const q = projectCanvas(p);
      i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
    });
    ctx.stroke();
  }
}

function inView(b) {
  return b.lat > 1.211 && b.lat < 1.220 && b.lon > -77.284 && b.lon < -77.273;
}

function projectCanvas(p) {
  return {
    x: (p.lon + 77.284) / 0.011 * canvas.clientWidth,
    y: canvas.clientHeight - (p.lat - 1.211) / 0.009 * canvas.clientHeight
  };
}

function resizeCanvas() {
  const d = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * d || canvas.height !== h * d) {
    canvas.width = w * d;
    canvas.height = h * d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
}

function updateMetrics() {
  const active = [...buses.values()].filter(b => b.inService !== false).length;
  $("busCount").textContent = `${buses.size} buses`;
  $("activeCount").textContent = active;
  $("riskCount").textContent = alerts.filter(a => a.type === "bunching").length;
  $("gapCount").textContent = alerts.filter(a => a.type === "service gap").length;
  $("inpValue").textContent = lastInp;
  $("lastKnown").textContent = `Ultimo estado: ${new Date().toLocaleTimeString()} - ${buses.size} buses`;
}

function renderAlerts() {
  $("alerts").innerHTML = alerts.length
    ? alerts.slice(0, 10).map(a => `<div class="alert"><b>${a.type.toUpperCase()}</b> - ${a.route} - Bus ${a.bus}<br>Brecha: ${(a.gap / 1000).toFixed(1)} min aprox - retener ${a.hold || 0} min</div>`).join("")
    : "<span>Sin alertas por ahora.</span>";
  updateMetrics();
}

function setupPerformance() {
  if (!("PerformanceObserver" in window)) return;
  try {
    new PerformanceObserver(list => {
      const entry = list.getEntries().at(-1);
      if (entry?.interactionId) lastInp = Math.round(entry.duration);
      $("performanceLog").innerHTML = `<span>INP: ${lastInp} ms</span><span>Workers: ${workerCount}</span><span>SAB: ${liveState.shared}</span><span>Long tasks se observan en PerformanceObserver</span>`;
      updateMetrics();
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch (_) {}
  try {
    new PerformanceObserver(list => {
      const long = list.getEntries().filter(e => e.duration > 50).length;
      $("performanceLog").innerHTML += `<span>Long tasks: ${long}</span>`;
    }).observe({ entryTypes: ["longtask"] });
  } catch (_) {}
}

async function queueAction(action) {
  const item = { id: crypto.randomUUID(), action, time: new Date().toISOString() };
  const req = indexedDB.open("case3", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("actions", { keyPath: "id" });
  req.onsuccess = () => {
    const db = req.result;
    db.transaction("actions", "readwrite").objectStore("actions").put(item);
    queueCount++;
    $("queueInfo").textContent = `Cola offline: ${queueCount}`;
    navigator.serviceWorker?.ready.then(r => r.sync?.register("supervisor-actions")).catch(() => {});
  };
}

function saveLastState() {
  const small = [...buses.values()].slice(0, 310).map(b => ({
    bus: b.bus, route: b.route, lat: b.lat, lon: b.lon, s: b.s, vel: b.vel,
    estimated: b.estimated, inService: b.inService, serverTs: b.serverTs
  }));
  localStorage.setItem("lastFleetState", JSON.stringify({ time: new Date().toISOString(), buses: small }));
}

function restoreLastState() {
  try {
    const saved = JSON.parse(localStorage.getItem("lastFleetState") || "null");
    if (!saved?.buses?.length) return false;
    saved.buses.forEach(b => buses.set(b.bus, { ...b, estimated: true }));
    $("lastKnown").textContent = `Ultimo estado guardado: ${new Date(saved.time).toLocaleTimeString()}`;
    publishLiveState();
    return true;
  } catch (_) {
    return false;
  }
}

function setConnection() {
  const offline = simulatedOffline || !navigator.onLine;
  $("connectionText").textContent = offline ? "Offline" : "En linea";
  $("connectionDot").style.background = offline ? "#d94b3d" : "#32b46b";
}

$("startBtn").onclick = () => {
  running = true;
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  tick();
};
$("stopBtn").onclick = () => {
  running = false;
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
};
$("bunchBtn").onclick = () => {
  forceBunch = true;
  setTimeout(() => { forceBunch = false; }, 15000);
};
$("offlineBtn").onclick = () => {
  simulatedOffline = !simulatedOffline;
  setConnection();
};
$("historyRange").oninput = e => {
  $("historyLabel").textContent = e.target.value === "120" ? "En vivo" : `${120 - e.target.value} min atras`;
};
document.querySelectorAll("[data-action]").forEach(b => b.onclick = () => queueAction(b.dataset.action));
window.addEventListener("resize", resizeCanvas);
window.addEventListener("online", setConnection);
window.addEventListener("offline", setConnection);

$("isolationBadge").textContent = `crossOriginIsolated: ${crossOriginIsolated}`;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
initWorkers();
if (!restoreLastState()) generateFleet().forEach(b => buses.set(b.bus, b));
publishLiveState();
setupPerformance();
renderAlerts();
updateMetrics();
setConnection();
draw();
