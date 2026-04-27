const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route surface runtime module");
const { wireGpxDownload } = await import(`./gpx.mjs${moduleSuffix}`);
const { createRouteMapView } = await import(`./route-map-view.mjs${moduleSuffix}`);
const {
  setControlsDisabled,
  updateRouteSurfaceState,
  updateDownloadLinkState,
} = await import(`./route-shell-view.mjs${moduleSuffix}`);
const { renderRouteSummary } = await import(`./route-summary-view.mjs${moduleSuffix}`);

export function createRouteSurfaceRuntime({
  areaSelect,
  startSelect,
  endSelect,
  scenarioLabel,
  newRouteButton,
  downloadLink,
  routeStrip,
  buttonRow,
  mapElement,
}) {
  let routeMapView = null;
  let gpxUrl = null;

  function ensureRouteMapView() {
    if (!routeMapView) {
      routeMapView = createRouteMapView(mapElement.id);
    }
    return routeMapView;
  }

  function syncShellState({ routeStatus, plannerReady, invalidated, controlsDisabledOverride, loadingLabel }) {
    setControlsDisabled(areaSelect, startSelect, endSelect, newRouteButton, {
      disabled: controlsDisabledOverride ?? !plannerReady,
      isLoading: routeStatus === "loading",
    });
    updateRouteSurfaceState(routeStrip, buttonRow, mapElement, invalidated, loadingLabel);
  }

  function syncDownloadLink({ route, routeStatus, scenario, startJunction, endJunction }) {
    if (!route || !scenario || routeStatus === "loading") {
      if (gpxUrl) {
        URL.revokeObjectURL(gpxUrl);
        gpxUrl = null;
      }
      updateDownloadLinkState(downloadLink, { enabled: false, href: null });
      return;
    }

    const download = wireGpxDownload(downloadLink, {
      route,
      startJunction,
      endJunction,
      previousUrl: gpxUrl,
    });
    gpxUrl = download.url;
    updateDownloadLinkState(downloadLink, { enabled: true, href: download.url });
  }

  return {
    ensureMap() {
      return ensureRouteMapView().ensureMap();
    },

    renderNetwork(network) {
      ensureRouteMapView().renderNetwork(network);
    },

    syncSummary({ route, routeStatus, scenario, loopArrowPhase, loadingLabel = null }) {
      renderRouteSummary(scenarioLabel, {
        route,
        routeStatus,
        isLoop: Boolean(scenario?.is_loop),
        loopArrowPhase,
        loadingLabel,
      });
    },

    syncLoadingProgress({
      route,
      routeStatus,
      plannerReady,
      scenario,
      loopArrowPhase,
      invalidated,
      controlsDisabledOverride = null,
      loadingLabel = null,
    }) {
      this.syncSummary({
        route,
        routeStatus,
        scenario,
        loopArrowPhase,
        loadingLabel,
      });
      syncShellState({
        routeStatus,
        plannerReady,
        invalidated,
        controlsDisabledOverride,
        loadingLabel,
      });
    },

    sync({
      route,
      routeStatus,
      plannerReady,
      scenario,
      startJunction,
      endJunction,
      loopArrowPhase,
      invalidated,
      controlsDisabledOverride = null,
      loadingLabel = null,
    }) {
      this.syncSummary({
        route,
        routeStatus,
        scenario,
        loopArrowPhase,
        loadingLabel,
      });
      syncDownloadLink({
        route,
        routeStatus,
        scenario,
        startJunction,
        endJunction,
      });
      syncShellState({
        routeStatus,
        plannerReady,
        invalidated,
        controlsDisabledOverride,
        loadingLabel,
      });
      ensureRouteMapView().renderRoute(route, {
        scenario,
        startJunction,
        endJunction,
      });
    },
  };
}
