const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleVersion: MODULE_VERSION, moduleSuffix } = requireVersionedModuleContext(import.meta, "Route controller module");
const { validateAppManifest } = await import(`./runtime-contracts.mjs${moduleSuffix}`);
const { parsePlannerWorkerResponse } = await import(`./planner-worker-contracts.mjs${moduleSuffix}`);
const { wireGpxDownload } = await import(`./gpx.mjs${moduleSuffix}`);
const { createRouteMapView } = await import(`./route-map-view.mjs${moduleSuffix}`);
const { createRouteRuntime } = await import(`./route-runtime.mjs${moduleSuffix}`);
const {
  setControlsDisabled,
  updateRouteSurfaceState,
  installShellPlaceholders,
  showError,
  clearError,
} = await import(`./route-shell-view.mjs${moduleSuffix}`);
const {
  canonicalizeSelectorScenario,
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
} = await import(`./route-scenarios.mjs${moduleSuffix}`);

export function createRouteController({
  appManifestUrl,
  elements,
  loopArrowIntervalMs = 1000,
}) {
  const {
    areaSelect,
    startSelect,
    endSelect,
    scenarioLabel,
    errorCard,
    newRouteButton,
    downloadLink,
    routeStrip,
    buttonRow,
    mapElement,
  } = elements;

  let loopArrowTimer = null;
  const appState = {
    manifest: null,
    area: null,
    network: null,
    route: null,
    routeMapView: null,
    gpxUrl: null,
    loopArrowPhase: 0,
    routeRuntime: createRouteRuntime({
      moduleVersion: MODULE_VERSION,
      parsePlannerWorkerResponse,
      onUnhandledError: (error) => {
        showError(errorCard, error.message || String(error));
        updateSummary();
      },
    }),
    routeStatus: "booting",
    activeRouteRequestId: 0,
    activeAreaLoadId: 0,
    routeHistoryByScenario: new Map(),
  };

  function networkUrlForArea() {
    const relativePath = appState.manifest.planner.network_path;
    const url = new URL(relativePath, appManifestUrl);
    url.searchParams.set("v", appState.manifest.planner.network_version);
    return url;
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

  function ensureRouteMapView() {
    if (!appState.routeMapView) {
      appState.routeMapView = createRouteMapView(mapElement.id);
    }
    return appState.routeMapView;
  }

  function renderNetwork() {
    ensureRouteMapView().renderNetwork(appState.network);
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
      disabled: !appState.routeRuntime.plannerReady,
      isLoading: appState.routeStatus === "loading",
      hasRoute: Boolean(appState.route),
    });
    updateRouteSurfaceState(routeStrip, buttonRow, mapElement, routeSurfaceIsInvalidated());
  }

  function beginRouteRefresh({ preserveRoute }) {
    appState.routeStatus = "loading";
    if (!preserveRoute) {
      appState.route = null;
    }
    updateSummary();
    if (!preserveRoute) {
      renderRoute();
    }
  }

  function failRouteRefresh(error, { preserveRoute, requestId = null }) {
    if (requestId != null && requestId !== appState.activeRouteRequestId) {
      return;
    }
    if (!preserveRoute) {
      appState.route = null;
    }
    appState.routeStatus = "error";
    updateSummary();
    if (!preserveRoute) {
      renderRoute();
    }
    showError(errorCard, error.message || String(error));
  }

  async function loadAreaNetwork() {
    const response = await fetch(networkUrlForArea());
    if (!response.ok) {
      throw new Error(`Failed to load network overlay: ${response.status}`);
    }
    return response.json();
  }

  async function initializePlanner(networkPayload) {
    await appState.routeRuntime.initializePlanner(networkPayload, appState.manifest.planner.config);
    clearError(errorCard);
  }

  async function chooseRoute() {
    const requestId = ++appState.activeRouteRequestId;
    const hadRoute = Boolean(appState.route);
    try {
      const scenario = currentScenario();
      syncUrlFromSelectors(areaSelect, startSelect, endSelect);
      if (!scenario || !appState.routeRuntime.plannerReady || !appState.area) {
        appState.route = null;
        updateSummary();
        renderRoute();
        return;
      }

      const { startJunction, endJunction } = currentJunctions();
      const seed = appState.routeRuntime.nextRouteSeed();
      beginRouteRefresh({ preserveRoute: hadRoute });
      const route = await appState.routeRuntime.requestRoute({
        routeId: `browser-${scenario.id}-seed${seed}`,
        seed,
        startNodeId: startJunction.graph_node_id,
        endNodeId: endJunction.graph_node_id,
        recentRouteContigSequences: recentRoutesForScenario(
          appState.routeHistoryByScenario,
          appState.area,
          scenario,
        ),
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
      failRouteRefresh(error, {
        preserveRoute: hadRoute,
        requestId,
      });
    }
  }

  async function loadArea(area) {
    const loadId = ++appState.activeAreaLoadId;
    appState.activeRouteRequestId += 1;
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
    if (loadId !== appState.activeAreaLoadId) {
      return;
    }
    await initializePlanner(networkPayload);
    if (loadId !== appState.activeAreaLoadId) {
      return;
    }
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
          appState.area.scenarios[0].end_junction_id,
        );
        await loadArea(appState.area);
      } catch (error) {
        appState.routeStatus = "error";
        updateSummary();
        showError(errorCard, error.message || String(error));
      }
    });

    startSelect.addEventListener("change", () => {
      canonicalizeSelectorScenario(startSelect, endSelect, appState.area, "start");
      void chooseRoute();
    });
    endSelect.addEventListener("change", () => {
      canonicalizeSelectorScenario(startSelect, endSelect, appState.area, "end");
      void chooseRoute();
    });
    newRouteButton.addEventListener("click", () => {
      void chooseRoute();
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
      endSelect,
    );
    appState.area = resolved.area;
    if (resolved.canonicalized) {
      console.warn("Canonicalized invalid route query parameters", resolved.canonical);
      replaceUrlWithSelection(resolved.canonical);
    }

    if (loopArrowTimer == null) {
      loopArrowTimer = window.setInterval(() => {
        appState.loopArrowPhase = (appState.loopArrowPhase + 1) % 2;
        const scenario = currentScenario();
        if (appState.route && scenario?.is_loop) {
          updateRouteStats();
        }
      }, loopArrowIntervalMs);
    }

    try {
      await loadArea(appState.area);
    } catch (error) {
      appState.routeStatus = "error";
      updateSummary();
      showError(errorCard, error.message || String(error));
    }
  }

  return {
    boot,
  };
}
