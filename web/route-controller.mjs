import { parsePlannerWorkerResponse } from "./planner-worker-contracts.mjs";
import { loadAppManifest, loadAreaAssets } from "./route-asset-runtime.mjs";
import { createRouteRuntime } from "./route-runtime.mjs";
import { createRouteSurfaceRuntime } from "./route-surface-runtime.mjs";
import {
  installShellPlaceholders,
  showError,
  clearError,
} from "./route-shell-view.mjs";
import {
  canonicalizeSelectorScenario,
  syncSelectorsFromQuery,
} from "./route-selection-controls.mjs";
import { populateJunctionSelectors } from "./route-selection-view.mjs";
import {
  replaceUrlWithSelection,
  syncUrlFromSelectors,
} from "./route-url-state.mjs";
import { setSummaryText } from "./route-summary-view.mjs";
import {
  recentRoutesForScenario,
  rememberRouteForScenario,
  requireScenario,
  junctionsForScenario,
} from "./route-scenarios.mjs";

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
  const routeSurfaceRuntime = createRouteSurfaceRuntime({
    areaSelect,
    startSelect,
    endSelect,
    scenarioLabel,
    newRouteButton,
    downloadLink,
    routeStrip,
    buttonRow,
    mapElement,
  });
  const appState = {
    manifest: null,
    area: null,
    network: null,
    route: null,
    loadingLabel: "Loading route options…",
    loopArrowPhase: 0,
    backgroundNetwork: null,
    routeRuntime: createRouteRuntime({
      parsePlannerWorkerResponse,
      onUnhandledError: (error) => {
        showError(errorCard, error.message || String(error));
        syncSurface();
      },
    }),
    routeStatus: "booting",
    activeRouteRequestId: 0,
    activeAreaLoadId: 0,
    routeHistoryByScenario: new Map(),
    controlsDisabledOverride: true,
  };

  function routeSurfaceIsInvalidated() {
    return appState.routeStatus === "loading" && Boolean(appState.route);
  }

  function setLoadingLabel(message) {
    appState.loadingLabel = message;
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

  function syncSurface() {
    const scenario = currentScenario();
    const { startJunction, endJunction } = currentJunctions();
    routeSurfaceRuntime.sync({
      route: appState.route,
      routeStatus: appState.routeStatus,
      plannerReady: appState.routeRuntime.plannerReady,
      scenario,
      startJunction,
      endJunction,
      loopArrowPhase: appState.loopArrowPhase,
      invalidated: routeSurfaceIsInvalidated(),
      controlsDisabledOverride: appState.controlsDisabledOverride,
      loadingLabel: appState.loadingLabel,
    });
  }

  function updateRouteSummary() {
    const scenario = currentScenario();
    routeSurfaceRuntime.syncSummary({
      route: appState.route,
      routeStatus: appState.routeStatus,
      loopArrowPhase: appState.loopArrowPhase,
      scenario,
      loadingLabel: appState.loadingLabel,
    });
  }

  function syncLoadingProgress() {
    const scenario = currentScenario();
    routeSurfaceRuntime.syncLoadingProgress({
      route: appState.route,
      routeStatus: appState.routeStatus,
      plannerReady: appState.routeRuntime.plannerReady,
      scenario,
      loopArrowPhase: appState.loopArrowPhase,
      invalidated: routeSurfaceIsInvalidated(),
      controlsDisabledOverride: appState.controlsDisabledOverride,
      loadingLabel: appState.loadingLabel,
    });
  }

  function beginRouteRefresh({ preserveRoute, loadingLabel }) {
    appState.routeStatus = "loading";
    setLoadingLabel(loadingLabel);
    if (!preserveRoute) {
      appState.route = null;
    }
    syncSurface();
  }

  function failRouteRefresh(error, { preserveRoute, requestId = null }) {
    if (requestId != null && requestId !== appState.activeRouteRequestId) {
      return;
    }
    if (!preserveRoute) {
      appState.route = null;
    }
    appState.routeStatus = "error";
    setLoadingLabel(null);
    syncSurface();
    showError(errorCard, error.message || String(error));
  }

  async function initializePlanner(networkPayload) {
    setLoadingLabel("Preparing route planner…");
    syncLoadingProgress();
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
        syncSurface();
        return;
      }

      const { startJunction, endJunction } = currentJunctions();
      const seed = appState.routeRuntime.nextRouteSeed();
      beginRouteRefresh({
        preserveRoute: hadRoute,
        loadingLabel: hadRoute ? "Searching route…" : "Computing first route…",
      });
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
      }, {
        onProgress: (partialRoute) => {
          if (requestId !== appState.activeRouteRequestId) {
            return;
          }
          const bestDistanceKm = (partialRoute.unique_length_m / 1000).toFixed(2);
          setLoadingLabel(`Searching route… ${bestDistanceKm} km best so far`);
          syncLoadingProgress();
        },
      });
      if (requestId !== appState.activeRouteRequestId) {
        return;
      }
      appState.route = route;
      appState.routeStatus = "ready";
      setLoadingLabel(null);
      rememberRouteForScenario(appState.routeHistoryByScenario, appState.area, scenario, route);
      syncSurface();
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
    appState.backgroundNetwork = null;
    appState.controlsDisabledOverride = true;
    setLoadingLabel("Loading route network…");
    syncSurface();
    routeSurfaceRuntime.renderBackgroundNetwork(null);

    const { plannerNetwork, backgroundNetwork } = await loadAreaAssets(appManifestUrl, appState.manifest);
    if (loadId !== appState.activeAreaLoadId) {
      return;
    }
    appState.backgroundNetwork = backgroundNetwork;
    routeSurfaceRuntime.renderBackgroundNetwork(backgroundNetwork);
    await initializePlanner(plannerNetwork);
    if (loadId !== appState.activeAreaLoadId) {
      return;
    }
    appState.network = plannerNetwork;
    appState.controlsDisabledOverride = false;
    syncSurface();
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
          appState.area.scenarios[0],
        );
        await loadArea(appState.area);
      } catch (error) {
        appState.routeStatus = "error";
        syncSurface();
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
    syncSurface();
    routeSurfaceRuntime.ensureMap();
    bindControls();

    try {
      appState.manifest = await loadAppManifest(appManifestUrl);
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
          updateRouteSummary();
        }
      }, loopArrowIntervalMs);
    }

    try {
      await loadArea(appState.area);
    } catch (error) {
      appState.routeStatus = "error";
      syncSurface();
      showError(errorCard, error.message || String(error));
    }
  }

  return {
    boot,
  };
}
