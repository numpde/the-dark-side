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
const { createRouteMapView } = await import(`./route-map-view.mjs${moduleSuffix}`);
const {
  setControlsDisabled,
  updateRouteSurfaceState,
  installShellPlaceholders,
  showError,
  clearError,
} = await import(`./route-shell-view.mjs${moduleSuffix}`);
const {
  populateJunctionSelectors,
  syncSelectorsFromQuery,
  replaceUrlWithSelection,
  syncUrlFromSelectors,
} = await import(`./route-selection-controls.mjs${moduleSuffix}`);
const { setSummaryText, renderRouteSummary } = await import(`./route-summary-view.mjs${moduleSuffix}`);
const {
  recentRoutesForScenario,
  rememberRouteForScenario,
  requireScenario,
  junctionsForScenario,
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
const mapElement = document.getElementById("map");
const LOOP_ARROW_INTERVAL_MS = 1000;

let appState = {
  manifest: null,
  area: null,
  network: null,
  route: null,
  routeMapView: null,
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

function routeSurfaceIsInvalidated() {
  return appState.routeStatus === "loading" && Boolean(appState.route);
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
  return junctionsForScenario(appState.area, scenario);
}


function renderNetwork() {
  ensureRouteMapView().renderNetwork(appState.network);
}


function ensureRouteMapView() {
  if (!appState.routeMapView) {
    appState.routeMapView = createRouteMapView("map");
  }
  return appState.routeMapView;
}


function renderRoute() {
  const route = appState.route;
  const scenario = currentScenario();
  const { startJunction, endJunction } = currentJunctions();
  ensureRouteMapView().renderRoute(route, {
    scenario,
    startJunction,
    endJunction,
  });
}


function updateRouteStats() {
  const scenario = currentScenario();
  renderRouteSummary(scenarioLabel, {
    title: scenario && appState.area ? scenarioLabelText(scenario, appState.area) : null,
    route: appState.route,
    routeStatus: appState.routeStatus,
    isLoop: Boolean(scenario?.is_loop),
    loopArrowPhase: appState.loopArrowPhase,
  });
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
  setControlsDisabled(areaSelect, startSelect, endSelect, newRouteButton, downloadLink, {
    disabled: !appState.plannerReady,
    isLoading: appState.routeStatus === "loading",
    hasRoute: Boolean(appState.route),
  });
  updateRouteSurfaceState(routeStrip, buttonRow, mapElement, routeSurfaceIsInvalidated());
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
      showError(errorCard, error.message || String(error));
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
  clearError(errorCard);
}


async function chooseRoute() {
  const scenario = currentScenario();
  syncUrlFromSelectors(areaSelect, startSelect, endSelect);
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
    clearError(errorCard);
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
    showError(errorCard, error.message || String(error));
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
  setControlsDisabled(areaSelect, startSelect, endSelect, newRouteButton, downloadLink, {
    disabled: true,
    isLoading: true,
    hasRoute: false,
  });

  const networkPayload = await loadAreaNetwork();
  await initializePlanner(networkPayload);
  appState.network = networkPayload;
  renderNetwork();
  setControlsDisabled(areaSelect, startSelect, endSelect, newRouteButton, downloadLink, {
    disabled: false,
    isLoading: false,
    hasRoute: Boolean(appState.route),
  });
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
        startSelect,
        endSelect,
        appState.area,
        appState.area.scenarios[0].start_junction_id,
        appState.area.scenarios[0].end_junction_id
      );
      await loadArea(appState.area);
    } catch (error) {
      appState.routeStatus = "error";
      updateSummary();
      showError(errorCard, error.message || String(error));
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
  clearError(errorCard);
  installShellPlaceholders(scenarioLabel, areaSelect, startSelect, endSelect);
  setControlsDisabled(areaSelect, startSelect, endSelect, newRouteButton, downloadLink, {
    disabled: true,
    isLoading: false,
    hasRoute: false,
  });
  ensureRouteMapView().ensureMap();
  bindControls();

  try {
    const response = await fetch(appManifestUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load app manifest: ${response.status}`);
    }
    appState.manifest = validateAppManifest(await response.json());
  } catch (error) {
    showError(errorCard, error.message || String(error));
    setSummaryText(scenarioLabel, "Failed to load routes");
    return;
  }

  const resolved = syncSelectorsFromQuery(
    appState.manifest,
    window.location.search,
    areaSelect,
    startSelect,
    endSelect
  );
  appState.area = resolved.area;
  if (resolved.canonicalized) {
    console.warn("Canonicalized invalid route query parameters", resolved.canonical);
    replaceUrlWithSelection(resolved.canonical);
  }

  try {
    await loadArea(appState.area);
  } catch (error) {
    appState.routeStatus = "error";
    updateSummary();
    showError(errorCard, error.message || String(error));
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
