function requireModuleVersion() {
  const version = new URL(import.meta.url).searchParams.get("v");
  if (!version) {
    throw new Error("App runtime is missing required module version");
  }
  return version;
}

const MODULE_VERSION = requireModuleVersion();
const moduleSuffix = `?v=${encodeURIComponent(MODULE_VERSION)}`;
const { validateAppManifest } = await import(`./runtime-contracts.mjs${moduleSuffix}`);
const { parsePlannerWorkerResponse } = await import(`./planner-worker-contracts.mjs${moduleSuffix}`);
const { createPlannerClient } = await import(`./planner-client.mjs${moduleSuffix}`);
const { wireGpxDownload } = await import(`./gpx.mjs${moduleSuffix}`);
const {
  recentRoutesForScenario,
  rememberRouteForScenario,
  requireScenario,
  junctionById,
  scenarioLabelText,
} = await import(`./route-scenarios.mjs${moduleSuffix}`);

const appManifestUrl = new URL("./generated/app-manifest.json", window.location.href);

const areaSelect = document.getElementById("area-select");
const startSelect = document.getElementById("start-select");
const endSelect = document.getElementById("end-select");
const scenarioLabel = document.getElementById("scenario-label");
const errorCard = document.getElementById("error-card");
const newRouteButton = document.getElementById("new-route-button");
const downloadLink = document.getElementById("download-link");
const routeStrip = document.querySelector(".route-strip");
const buttonRow = document.querySelector(".button-row");
const mapView = document.getElementById("map");
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
  plannerClient: null,
  plannerReady: false,
  routeStatus: "booting",
  activeRouteRequestId: 0,
  routeSeedCounter: Math.floor(Math.random() * 1_000_000),
  routeHistoryByScenario: new Map(),
};


function networkUrlForArea() {
  const relativePath = appState.manifest.planner.network_path;
  const url = new URL(relativePath, appManifestUrl);
  url.searchParams.set("v", appState.manifest.planner.network_version);
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

function routeSurfaceIsInvalidated() {
  return appState.routeStatus === "loading" && Boolean(appState.route);
}

function updateRouteSurfaceState() {
  const invalidated = routeSurfaceIsInvalidated();
  routeStrip.classList.toggle("is-stale", invalidated);
  buttonRow.classList.toggle("is-stale", invalidated);
  mapView.classList.toggle("is-stale", invalidated);
}


function installShellPlaceholders() {
  setScenarioLabelText("Loading routes…");
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


function setScenarioLabelText(text) {
  scenarioLabel.textContent = text;
}


function setScenarioLabelParts(title, metaText) {
  scenarioLabel.replaceChildren();
  const titleSpan = document.createElement("span");
  titleSpan.className = "scenario-title-main";
  titleSpan.textContent = title;

  if (!metaText) {
    scenarioLabel.append(titleSpan);
    return;
  }

  const separatorSpan = document.createElement("span");
  separatorSpan.className = "scenario-title-separator";
  separatorSpan.textContent = ", ";

  const metaSpan = document.createElement("span");
  metaSpan.className = "scenario-title-meta";
  metaSpan.textContent = metaText;

  scenarioLabel.append(titleSpan, separatorSpan, metaSpan);
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
    setScenarioLabelText("Loading routes…");
    return;
  }

  if (appState.routeStatus === "loading" && !appState.route) {
    setScenarioLabelText(`${scenarioLabelText(scenario, appState.area)}…`);
    return;
  }

  const route = appState.route;
  if (!route) {
    setScenarioLabelText(scenarioLabelText(scenario, appState.area));
    return;
  }

  const hasGain = typeof route.elevation_gain_m === "number";
  const hasLoss = typeof route.elevation_loss_m === "number";
  let metaText = formatDistance(route.unique_length_m);
  if (scenario.is_loop && hasGain && hasLoss) {
    const averageChange = (route.elevation_gain_m + route.elevation_loss_m) / 2;
    metaText += ` (${animatedLoopArrow()} ${formatElevationChange(averageChange)})`;
  } else if (hasGain || hasLoss) {
    const upText = hasGain ? formatElevationChange(route.elevation_gain_m) : "—";
    const downText = hasLoss ? formatElevationChange(route.elevation_loss_m) : "—";
    metaText += ` (↗ ${upText}, ↘ ${downText})`;
  }
  setScenarioLabelParts(scenarioLabelText(scenario, appState.area), metaText);
}


function updateDownloadLink() {
  const route = appState.route;
  const scenario = currentScenario();
  if (!route || !scenario || appState.routeStatus === "loading") {
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
  updateRouteSurfaceState();
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


function ensurePlannerClient() {
  if (appState.plannerClient) {
    return appState.plannerClient;
  }
  appState.plannerClient = createPlannerClient({
    moduleVersion: MODULE_VERSION,
    parsePlannerWorkerResponse,
    onUnhandledError: (error) => {
      showError(error.message || String(error));
    },
  });
  return appState.plannerClient;
}


function sendWorkerMessage(type, payload, { onProgress = null } = {}) {
  return ensurePlannerClient().request(type, payload, { onProgress });
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
  const hadRoute = Boolean(appState.route);
  appState.routeStatus = "loading";
  if (!hadRoute) {
    appState.route = null;
  }
  updateSummary();
  if (!hadRoute) {
    renderRoute();
  }

  try {
    const route = await sendWorkerMessage("plan", {
      routeId: `browser-${scenario.id}-seed${seed}`,
      seed,
      startNodeId: startJunction.graph_node_id,
      endNodeId: endJunction.graph_node_id,
      recentRouteContigSequences: recentRoutesForScenario(appState.routeHistoryByScenario, appState.area, scenario),
    });
    if (requestId !== appState.activeRouteRequestId) {
      return;
    }
    appState.route = route;
    appState.routeStatus = "ready";
    rememberRouteForScenario(appState.routeHistoryByScenario, appState.area, scenario, route);
    updateSummary();
    renderRoute();
    clearError();
  } catch (error) {
    if (requestId !== appState.activeRouteRequestId) {
      return;
    }
    if (!hadRoute) {
      appState.route = null;
    }
    appState.routeStatus = "error";
    updateSummary();
    if (!hadRoute) {
      renderRoute();
    }
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
    try {
      const selectedArea = appState.manifest.areas.find((item) => item.id === areaSelect.value);
      if (!selectedArea) {
        throw new Error(`Unknown area id ${areaSelect.value}`);
      }
      appState.area = selectedArea;
      areaSelect.value = appState.area.id;
      populateJunctionSelectors(
        appState.area,
        appState.area.scenarios[0].start_junction_id,
        appState.area.scenarios[0].end_junction_id
      );
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
    setScenarioLabelText("Failed to load routes");
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
