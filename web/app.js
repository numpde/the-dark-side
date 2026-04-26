const MODULE_VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const moduleSuffix = MODULE_VERSION ? `?v=${encodeURIComponent(MODULE_VERSION)}` : "";
const { wireGpxDownload } = await import(`./gpx.mjs${moduleSuffix}`);

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

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`App manifest is missing valid ${label}`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`App manifest is missing valid ${label}`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`App manifest is missing valid ${label}`);
  }
  return value;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`App manifest is missing valid ${label}`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`App manifest is missing valid ${label}`);
  }
  return value;
}

function validateJunction(junction, index) {
  const normalized = requireObject(junction, `areas[0].junctions[${index}]`);
  const location = requireObject(normalized.location, `areas[0].junctions[${index}].location`);
  requireString(normalized.id, `areas[0].junctions[${index}].id`);
  requireString(normalized.name, `areas[0].junctions[${index}].name`);
  requireFiniteNumber(location.lat, `areas[0].junctions[${index}].location.lat`);
  requireFiniteNumber(location.lon, `areas[0].junctions[${index}].location.lon`);
  requireInteger(normalized.graph_node_id, `areas[0].junctions[${index}].graph_node_id`);
  requireArray(normalized.tags ?? [], `areas[0].junctions[${index}].tags`);
  return normalized;
}

function validateScenario(scenario, index, junctionIds) {
  const normalized = requireObject(scenario, `areas[0].scenarios[${index}]`);
  requireString(normalized.id, `areas[0].scenarios[${index}].id`);
  const startJunctionId = requireString(
    normalized.start_junction_id,
    `areas[0].scenarios[${index}].start_junction_id`
  );
  const endJunctionId = requireString(
    normalized.end_junction_id,
    `areas[0].scenarios[${index}].end_junction_id`
  );
  if (!junctionIds.has(startJunctionId)) {
    throw new Error(`App manifest scenario ${normalized.id} references unknown start junction ${startJunctionId}`);
  }
  if (!junctionIds.has(endJunctionId)) {
    throw new Error(`App manifest scenario ${normalized.id} references unknown end junction ${endJunctionId}`);
  }
  if (typeof normalized.is_loop !== "boolean") {
    throw new Error(`App manifest is missing valid areas[0].scenarios[${index}].is_loop`);
  }
  return normalized;
}

function validateArea(area, index) {
  const normalized = requireObject(area, `areas[${index}]`);
  requireString(normalized.id, `areas[${index}].id`);
  requireString(normalized.name, `areas[${index}].name`);
  requireArray(normalized.bounds, `areas[${index}].bounds`);
  if (normalized.bounds.length !== 4) {
    throw new Error(`App manifest is missing valid areas[${index}].bounds`);
  }
  normalized.bounds.forEach((value, boundsIndex) => {
    requireFiniteNumber(value, `areas[${index}].bounds[${boundsIndex}]`);
  });
  const junctions = requireArray(normalized.junctions, `areas[${index}].junctions`);
  if (junctions.length === 0) {
    throw new Error(`App manifest must contain at least one junction in areas[${index}]`);
  }
  junctions.forEach(validateJunction);
  const junctionIds = new Set(junctions.map((junction) => junction.id));
  const scenarios = requireArray(normalized.scenarios, `areas[${index}].scenarios`);
  if (scenarios.length === 0) {
    throw new Error(`App manifest must contain at least one scenario in areas[${index}]`);
  }
  scenarios.forEach((scenario, scenarioIndex) => validateScenario(scenario, scenarioIndex, junctionIds));
  return normalized;
}

function validateAppManifest(manifest) {
  const normalized = requireObject(manifest, "root object");
  requireObject(normalized.meta ?? {}, "meta");
  const planner = requireObject(normalized.planner, "planner");
  requireString(planner.network_path, "planner.network_path");
  requireObject(planner.config, "planner.config");
  const areas = requireArray(normalized.areas, "areas");
  if (areas.length === 0) {
    throw new Error("App manifest must contain at least one area");
  }
  areas.forEach(validateArea);
  return normalized;
}


function networkUrlForArea() {
  const relativePath = appState.manifest?.planner?.network_path;
  if (!relativePath) {
    throw new Error("App manifest is missing planner.network_path");
  }
  const url = new URL(relativePath, appManifestUrl);
  const version = appState.manifest?.planner?.network_version;
  if (version) {
    url.searchParams.set("v", version);
  }
  return url;
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

function findScenario(area, startJunctionId, endJunctionId) {
  if (!area) {
    return null;
  }
  return area.scenarios.find(
    (item) => item.start_junction_id === startJunctionId && item.end_junction_id === endJunctionId
  ) || null;
}

function requireScenario(area, startJunctionId, endJunctionId, label = "scenario selection") {
  const scenario = findScenario(area, startJunctionId, endJunctionId);
  if (!scenario) {
    throw new Error(`Invalid ${label}: ${startJunctionId} -> ${endJunctionId}`);
  }
  return scenario;
}

function junctionById(area, junctionId) {
  const junction = area.junctions.find((item) => item.id === junctionId);
  if (!junction) {
    throw new Error(`Unknown junction id ${junctionId}`);
  }
  return junction;
}


function scenarioLabelText(scenario, area) {
  const start = junctionById(area, scenario.start_junction_id);
  const end = junctionById(area, scenario.end_junction_id);
  if (scenario.is_loop) {
    return `${start.name} loop`;
  }
  return `${start.name} to ${end.name}`;
}


function currentScenario() {
  if (!appState.area) {
    return null;
  }
  return requireScenario(appState.area, startSelect.value, endSelect.value);
}


function currentJunctions() {
  const scenario = currentScenario();
  if (!scenario || !appState.area) {
    return { startJunction: null, endJunction: null };
  }
  return {
    startJunction: junctionById(appState.area, scenario.start_junction_id),
    endJunction: junctionById(appState.area, scenario.end_junction_id),
  };
}


function junctionLatLon(junction) {
  if (!junction) {
    return null;
  }
  return [junction.location.lat, junction.location.lon];
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


function canonicalSelectionFromQuery() {
  const query = new URLSearchParams(window.location.search);
  const areas = appState.manifest.areas;
  const requestedAreaId = query.get("area");
  const requestedArea = areas.find((item) => item.id === requestedAreaId);
  const area = requestedArea ?? areas[0];
  const requestedStart = query.get("start");
  const requestedEnd = query.get("end");
  const matchedScenario = area.scenarios.find(
    (item) => item.start_junction_id === requestedStart && item.end_junction_id === requestedEnd
  );
  const scenario = matchedScenario ?? area.scenarios[0];
  const canonical = {
    areaId: area.id,
    startJunctionId: scenario.start_junction_id,
    endJunctionId: scenario.end_junction_id,
  };
  const queryState = {
    areaId: requestedAreaId,
    startJunctionId: requestedStart,
    endJunctionId: requestedEnd,
  };
  return {
    area,
    scenario,
    canonical,
    canonicalized:
      queryState.areaId !== canonical.areaId
      || queryState.startJunctionId !== canonical.startJunctionId
      || queryState.endJunctionId !== canonical.endJunctionId,
  };
}


function replaceUrlWithSelection(selection) {
  const query = new URLSearchParams(window.location.search);
  query.set("area", selection.areaId);
  query.set("start", selection.startJunctionId);
  query.set("end", selection.endJunctionId);
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

  const exactScenario = requireScenario(area, requestedStart, requestedEnd, "junction selector state");

  startSelect.value = exactScenario.start_junction_id;
  endSelect.value = exactScenario.end_junction_id;
}


function syncSelectorsFromQuery() {
  const resolved = canonicalSelectionFromQuery();
  appState.area = resolved.area;
  populateAreaOptions();
  areaSelect.value = appState.area.id;
  populateJunctionSelectors(
    appState.area,
    resolved.scenario.start_junction_id,
    resolved.scenario.end_junction_id
  );
  if (resolved.canonicalized) {
    console.warn("Canonicalized invalid route query parameters", resolved.canonical);
    replaceUrlWithSelection(resolved.canonical);
  }
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
  const workerUrl = new URL("./route-worker.js", import.meta.url);
  if (MODULE_VERSION) {
    workerUrl.searchParams.set("v", MODULE_VERSION);
  }
  const worker = new Worker(workerUrl, { type: "module" });
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
    const response = await fetch(appManifestUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load app manifest: ${response.status}`);
    }
    appState.manifest = validateAppManifest(await response.json());
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
