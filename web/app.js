import { wireGpxDownload } from "./gpx.mjs";

const appManifestUrl = new URL("./generated/app-manifest.json", window.location.href);

const areaSelect = document.getElementById("area-select");
const startSelect = document.getElementById("start-select");
const endSelect = document.getElementById("end-select");
const scenarioLabel = document.getElementById("scenario-label");
const errorCard = document.getElementById("error-card");
const newRouteButton = document.getElementById("new-route-button");
const downloadLink = document.getElementById("download-link");
const LOOP_ARROW_INTERVAL_MS = 1000;

let appState = {
  manifest: null,
  area: null,
  network: null,
  route: null,
  map: null,
  networkLayer: null,
  routeLayer: null,
  markerLayer: null,
  gpxUrl: null,
  loopArrowPhase: 0,
  plannerWorker: null,
  plannerReady: false,
  routeStatus: "booting",
  workerRequestId: 0,
  activeRouteRequestId: 0,
  pendingWorkerRequests: new Map(),
  routeSeedCounter: Math.floor(Math.random() * 1_000_000),
};


function networkUrlForArea() {
  return new URL(`./generated/${appState.manifest.planner.network_path}`, window.location.href);
}


function nextRouteSeed() {
  appState.routeSeedCounter += 1;
  return appState.routeSeedCounter;
}


function setControlsDisabled(disabled) {
  areaSelect.disabled = disabled;
  startSelect.disabled = disabled;
  endSelect.disabled = disabled;
  newRouteButton.disabled = disabled || appState.routeStatus === "loading";
  downloadLink.classList.toggle("disabled", disabled || !appState.route);
  if (disabled || !appState.route) {
    downloadLink.removeAttribute("href");
  }
}


function installShellPlaceholders() {
  scenarioLabel.textContent = "Loading routes…";
  areaSelect.innerHTML = "<option>Loading…</option>";
  startSelect.innerHTML = "<option>Loading…</option>";
  endSelect.innerHTML = "<option>Loading…</option>";
  setControlsDisabled(true);
}


function showError(message) {
  errorCard.textContent = message;
  errorCard.classList.remove("hidden");
}


function clearError() {
  errorCard.textContent = "";
  errorCard.classList.add("hidden");
}


function formatDistance(lengthM) {
  return `${(lengthM / 1000).toFixed(2)} km`;
}


function formatElevationChange(lengthM) {
  return `${lengthM.toFixed(0)} m`;
}


function animatedLoopArrow() {
  return appState.loopArrowPhase % 2 === 0 ? "↗" : "↘";
}


function mixColor(start, end, fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const values = start.map((value, index) =>
    Math.round(value + (end[index] - value) * clamped)
  );
  return `rgb(${values[0]}, ${values[1]}, ${values[2]})`;
}


function boundsToLeaflet(bounds) {
  return [
    [bounds[1], bounds[0]],
    [bounds[3], bounds[2]],
  ];
}


function scenarioId(startJunctionId, endJunctionId) {
  return `${startJunctionId}__to__${endJunctionId}`;
}


function scenarioLabelText(scenario, area) {
  const start = area.junctions.find((item) => item.id === scenario.start_junction_id);
  const end = area.junctions.find((item) => item.id === scenario.end_junction_id);
  if (!start || !end) {
    return scenario.id;
  }
  if (scenario.is_loop) {
    return `${start.name} loop`;
  }
  return `${start.name} to ${end.name}`;
}


function currentScenario() {
  if (!appState.area) {
    return null;
  }
  return appState.area.scenarios.find(
    (item) => item.id === scenarioId(startSelect.value, endSelect.value)
  );
}


function currentJunctions() {
  const scenario = currentScenario();
  if (!scenario || !appState.area) {
    return { startJunction: null, endJunction: null };
  }
  return {
    startJunction: appState.area.junctions.find((item) => item.id === scenario.start_junction_id) || null,
    endJunction: appState.area.junctions.find((item) => item.id === scenario.end_junction_id) || null,
  };
}


function junctionLatLon(junction) {
  if (!junction) {
    return null;
  }
  if (typeof junction.lat === "number" && typeof junction.lon === "number") {
    return [junction.lat, junction.lon];
  }
  if (junction.location && typeof junction.location.lat === "number" && typeof junction.location.lon === "number") {
    return [junction.location.lat, junction.location.lon];
  }
  return null;
}


function ensureMap() {
  if (appState.map) {
    return appState.map;
  }
  const map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  });
  map.setView([-1.2418, 36.8315], 14);
  map.createPane("network-pane");
  map.getPane("network-pane").style.zIndex = "350";
  map.createPane("route-pane");
  map.getPane("route-pane").style.zIndex = "450";
  map.createPane("marker-pane");
  map.getPane("marker-pane").style.zIndex = "500";
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
  appState.map = map;
  return map;
}


function renderNetwork() {
  const map = ensureMap();
  if (appState.networkLayer) {
    appState.networkLayer.remove();
  }
  if (!appState.network) {
    return;
  }
  appState.networkLayer = L.geoJSON(appState.network, {
    style: {
      color: "#3d4f46",
      weight: 2,
      opacity: 0.33,
    },
    pane: "network-pane",
  }).addTo(map);
}


function renderRoute() {
  const map = ensureMap();
  if (appState.routeLayer) {
    appState.routeLayer.remove();
  }
  if (appState.markerLayer) {
    appState.markerLayer.remove();
  }

  const route = appState.route;
  const scenario = currentScenario();
  if (!route || !scenario) {
    return;
  }

  const routeLayer = L.layerGroup();
  const startColor = [36, 96, 220];
  const endColor = [230, 40, 40];
  const totalSegments = Math.max(1, route.coordinates.length - 1);

  route.coordinates.forEach((_, index) => {
    if (index === route.coordinates.length - 1) {
      return;
    }
    const first = route.coordinates[index];
    const second = route.coordinates[index + 1];
    const fraction = index / totalSegments;
    L.polyline(
      [
        [first[1], first[0]],
        [second[1], second[0]],
      ],
      {
        color: mixColor(startColor, endColor, fraction),
        weight: 6,
        opacity: 0.92,
        lineCap: "round",
        pane: "route-pane",
      }
    ).addTo(routeLayer);
  });

  const markerLayer = L.layerGroup();
  const { startJunction, endJunction } = currentJunctions();
  const startLatLon = junctionLatLon(startJunction);
  const endLatLon = junctionLatLon(endJunction);
  if (startJunction && startLatLon) {
    L.circleMarker(startLatLon, {
      radius: 7,
      color: "#ffffff",
      weight: 3,
      fillColor: "#2d8c4d",
      fillOpacity: 1,
      pane: "marker-pane",
    }).bindTooltip(`Start: ${startJunction.name}`, { direction: "top" }).addTo(markerLayer);
  }
  if (endJunction && endLatLon) {
    L.circleMarker(endLatLon, {
      radius: 7,
      color: "#ffffff",
      weight: 3,
      fillColor: "#245ac9",
      fillOpacity: 1,
      pane: "marker-pane",
    }).bindTooltip(`End: ${endJunction.name}`, { direction: "top" }).addTo(markerLayer);
  }

  routeLayer.addTo(map);
  markerLayer.addTo(map);
  appState.routeLayer = routeLayer;
  appState.markerLayer = markerLayer;
  map.fitBounds(boundsToLeaflet(route.bounds), {
    padding: [28, 28],
    maxZoom: 16,
  });
}


function updateRouteStats() {
  const scenario = currentScenario();
  if (!scenario || !appState.area) {
    scenarioLabel.textContent = "Loading routes…";
    return;
  }

  if (appState.routeStatus === "loading") {
    scenarioLabel.textContent = `${scenarioLabelText(scenario, appState.area)}…`;
    return;
  }

  const route = appState.route;
  if (!route) {
    scenarioLabel.textContent = scenarioLabelText(scenario, appState.area);
    return;
  }

  const hasGain = typeof route.elevation_gain_m === "number";
  const hasLoss = typeof route.elevation_loss_m === "number";
  let summaryText = `${scenarioLabelText(scenario, appState.area)}, ${formatDistance(route.unique_length_m)}`;
  if (scenario.is_loop && hasGain && hasLoss) {
    const averageChange = (route.elevation_gain_m + route.elevation_loss_m) / 2;
    summaryText += ` (${animatedLoopArrow()} ${formatElevationChange(averageChange)})`;
  } else if (hasGain || hasLoss) {
    const upText = hasGain ? formatElevationChange(route.elevation_gain_m) : "—";
    const downText = hasLoss ? formatElevationChange(route.elevation_loss_m) : "—";
    summaryText += ` (↗ ${upText}, ↘ ${downText})`;
  }
  scenarioLabel.textContent = summaryText;
}


function updateDownloadLink() {
  const route = appState.route;
  const scenario = currentScenario();
  if (!route || !scenario) {
    if (appState.gpxUrl) {
      URL.revokeObjectURL(appState.gpxUrl);
      appState.gpxUrl = null;
    }
    downloadLink.removeAttribute("href");
    downloadLink.classList.add("disabled");
    return;
  }

  const { startJunction, endJunction } = currentJunctions();
  const download = wireGpxDownload(downloadLink, {
    route,
    startJunction,
    endJunction,
    previousUrl: appState.gpxUrl,
  });
  appState.gpxUrl = download.url;
  downloadLink.classList.remove("disabled");
}


function updateSummary() {
  updateRouteStats();
  updateDownloadLink();
  newRouteButton.disabled = !appState.plannerReady || appState.routeStatus === "loading";
}


function updateUrl() {
  const query = new URLSearchParams(window.location.search);
  query.set("area", areaSelect.value);
  query.set("start", startSelect.value);
  query.set("end", endSelect.value);
  window.history.replaceState({}, "", `${window.location.pathname}?${query.toString()}`);
}


function populateAreaOptions() {
  areaSelect.innerHTML = "";
  appState.manifest.areas.forEach((area) => {
    const option = document.createElement("option");
    option.value = area.id;
    option.textContent = area.name;
    areaSelect.append(option);
  });
}


function populateJunctionSelectors(area, requestedStart, requestedEnd) {
  startSelect.innerHTML = "";
  endSelect.innerHTML = "";
  area.junctions.forEach((junction) => {
    const startOption = document.createElement("option");
    startOption.value = junction.id;
    startOption.textContent = junction.name;
    startSelect.append(startOption);

    const endOption = document.createElement("option");
    endOption.value = junction.id;
    endOption.textContent = junction.name;
    endSelect.append(endOption);
  });

  const exactScenario = area.scenarios.find(
    (item) => item.start_junction_id === requestedStart && item.end_junction_id === requestedEnd
  ) || area.scenarios[0];

  startSelect.value = exactScenario.start_junction_id;
  endSelect.value = exactScenario.end_junction_id;
}


function syncSelectorsFromQuery() {
  const query = new URLSearchParams(window.location.search);
  const requestedAreaId = query.get("area") || appState.manifest.areas[0].id;
  appState.area = appState.manifest.areas.find((item) => item.id === requestedAreaId) || appState.manifest.areas[0];
  populateAreaOptions();
  areaSelect.value = appState.area.id;

  const requestedStart = query.get("start") || appState.area.scenarios[0].start_junction_id;
  const requestedEnd = query.get("end") || appState.area.scenarios[0].end_junction_id;
  populateJunctionSelectors(appState.area, requestedStart, requestedEnd);
}


async function loadAreaNetwork() {
  const response = await fetch(networkUrlForArea());
  if (!response.ok) {
    throw new Error(`Failed to load network overlay: ${response.status}`);
  }
  return response.json();
}


function ensurePlannerWorker() {
  if (appState.plannerWorker) {
    return appState.plannerWorker;
  }
  const worker = new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event) => {
    const { requestId, type, payload } = event.data || {};
    const pending = appState.pendingWorkerRequests.get(requestId);
    if (!pending) {
      return;
    }
    appState.pendingWorkerRequests.delete(requestId);
    if (type === "error") {
      pending.reject(new Error(payload?.message || "Worker error"));
      return;
    }
    pending.resolve(payload);
  });
  worker.addEventListener("error", (event) => {
    for (const pending of appState.pendingWorkerRequests.values()) {
      pending.reject(event.error || new Error(event.message || "Worker failed"));
    }
    appState.pendingWorkerRequests.clear();
  });
  appState.plannerWorker = worker;
  return worker;
}


function sendWorkerMessage(type, payload) {
  const worker = ensurePlannerWorker();
  const requestId = ++appState.workerRequestId;
  return new Promise((resolve, reject) => {
    appState.pendingWorkerRequests.set(requestId, { resolve, reject });
    worker.postMessage({ type, requestId, payload });
  });
}


async function initializePlanner(networkPayload) {
  appState.plannerReady = false;
  await sendWorkerMessage("init", {
    network: networkPayload,
    config: appState.manifest.planner.config,
  });
  appState.plannerReady = true;
  clearError();
}


async function chooseRoute() {
  const scenario = currentScenario();
  updateUrl();
  if (!scenario || !appState.plannerReady || !appState.area) {
    appState.route = null;
    updateSummary();
    renderRoute();
    return;
  }

  const { startJunction, endJunction } = currentJunctions();
  const requestId = ++appState.activeRouteRequestId;
  const seed = nextRouteSeed();
  appState.routeStatus = "loading";
  appState.route = null;
  updateSummary();
  renderRoute();

  try {
    const route = await sendWorkerMessage("plan", {
      routeId: `browser-${scenario.id}-seed${seed}`,
      seed,
      startNodeId: startJunction.graph_node_id,
      endNodeId: endJunction.graph_node_id,
    });
    if (requestId !== appState.activeRouteRequestId) {
      return;
    }
    appState.route = route;
    appState.routeStatus = "ready";
    updateSummary();
    renderRoute();
    clearError();
  } catch (error) {
    if (requestId !== appState.activeRouteRequestId) {
      return;
    }
    appState.route = null;
    appState.routeStatus = "error";
    updateSummary();
    renderRoute();
    showError(error.message || String(error));
  }
}


async function loadArea(area) {
  appState.plannerReady = false;
  appState.routeStatus = "loading";
  appState.route = null;
  appState.network = null;
  updateSummary();
  renderRoute();
  renderNetwork();
  setControlsDisabled(true);

  const networkPayload = await loadAreaNetwork();
  await initializePlanner(networkPayload);
  appState.network = networkPayload;
  renderNetwork();
  setControlsDisabled(false);
  await chooseRoute();
}


function bindControls() {
  areaSelect.addEventListener("change", async () => {
    appState.area = appState.manifest.areas.find((item) => item.id === areaSelect.value) || appState.manifest.areas[0];
    areaSelect.value = appState.area.id;
    populateJunctionSelectors(
      appState.area,
      appState.area.scenarios[0].start_junction_id,
      appState.area.scenarios[0].end_junction_id
    );
    try {
      await loadArea(appState.area);
    } catch (error) {
      appState.routeStatus = "error";
      updateSummary();
      showError(error.message || String(error));
    }
  });

  startSelect.addEventListener("change", () => {
    chooseRoute();
  });
  endSelect.addEventListener("change", () => {
    chooseRoute();
  });
  newRouteButton.addEventListener("click", () => {
    chooseRoute();
  });
}


async function boot() {
  clearError();
  installShellPlaceholders();
  ensureMap();
  bindControls();

  try {
    const response = await fetch(appManifestUrl);
    if (!response.ok) {
      throw new Error(`Failed to load app manifest: ${response.status}`);
    }
    appState.manifest = await response.json();
  } catch (error) {
    showError(error.message || String(error));
    scenarioLabel.textContent = "Failed to load routes";
    return;
  }

  syncSelectorsFromQuery();

  try {
    await loadArea(appState.area);
  } catch (error) {
    appState.routeStatus = "error";
    updateSummary();
    showError(error.message || String(error));
  }
}


boot();


window.setInterval(() => {
  appState.loopArrowPhase = (appState.loopArrowPhase + 1) % 2;
  const scenario = currentScenario();
  if (appState.route && scenario?.is_loop) {
    updateRouteStats();
  }
}, LOOP_ARROW_INTERVAL_MS);
