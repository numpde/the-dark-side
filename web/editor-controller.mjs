const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Editor controller module");
const {
  buildRoutePolicyDocument,
  defaultWayPolicy,
  emptyRoutePolicyDocument,
  normalizeRoutePolicyDocument,
  policyForContig,
  setContigPolicy,
} = await import(`./editor-state.mjs${moduleSuffix}`);
const {
  karuraTodayString,
  isCurrentlyUnavailable: isPolicyCurrentlyUnavailable,
} = await import(`./karura-policy.mjs${moduleSuffix}`);
const {
  downloadJsonDocument,
  loadEditorBundle,
  readJsonFile,
} = await import(`./editor-asset-runtime.mjs${moduleSuffix}`);
const { createEditorMapView, styleForPolicy } = await import(`./editor-map-view.mjs${moduleSuffix}`);
const { createEditorShellView } = await import(`./editor-shell-view.mjs${moduleSuffix}`);
const { validateEditorManifest } = await import(`./runtime-contracts.mjs${moduleSuffix}`);

function isCurrentlyUnavailable(policy) {
  return isPolicyCurrentlyUnavailable(
    { "local:unavailable_until": policy.unavailableUntil ?? undefined },
    karuraTodayString(),
  );
}

function isDefaultPolicy(policy) {
  return (
    policy.routingState === "default" &&
    policy.bikeability == null &&
    policy.bicycleDirection === "both" &&
    policy.unavailableUntil == null
  );
}

export function createEditorController({ editorManifestUrl, reportError }) {
  const appState = {
    selectedContigId: null,
    editorState: normalizeRoutePolicyDocument(emptyRoutePolicyDocument()),
    loadedRoutePolicyLabel: "–",
    editorManifest: null,
    assetUrls: null,
  };

  function canonicalRoutePolicyPath() {
    return appState.assetUrls.routePolicyPath;
  }

  const mapView = createEditorMapView({
    mapElementId: "map",
    onSelectContig: (contigId) => selectContig(contigId),
    resolveFeatureStyle: (feature) => styleForPolicy(
      policyForContig(appState.editorState, feature.properties.contig_id),
      isCurrentlyUnavailable,
    ),
  });

  const shellView = createEditorShellView({
    reportError,
    onRoutingStateChange: (routingState) => updateSelectedPolicy({ routingState }),
    onBikeabilityChange: (bikeability) => updateSelectedPolicy({ bikeability }),
    onDirectionChange: (bicycleDirection) => updateSelectedPolicy({ bicycleDirection }),
    onUnavailableUntilChange: (unavailableUntil) => updateSelectedPolicy({ unavailableUntil }),
    onClear: () => {
      if (appState.selectedContigId == null) {
        return;
      }
      setContigPolicy(appState.editorState, appState.selectedContigId, defaultWayPolicy());
      mapView.updateContigStyle(appState.selectedContigId);
      shellView.clearError();
      renderShell();
    },
    onExport: () => exportRoutePolicy(),
    onImportFile: async (file) => {
      await importRoutePolicy(file);
      shellView.clearError();
    },
  });

  function currentRoutePolicyDocument() {
    return buildRoutePolicyDocument(appState.editorState, mapView.getContigFeatures());
  }

  function renderShell() {
    const feature = mapView.featureForContig(appState.selectedContigId);
    const policy = feature
      ? policyForContig(appState.editorState, appState.selectedContigId)
      : defaultWayPolicy();

    shellView.update({
      feature,
      policy,
      loadedRoutePolicyLabel: appState.loadedRoutePolicyLabel,
      canonicalRoutePolicyPath: canonicalRoutePolicyPath(),
      editorGraphAssetId: appState.editorManifest.meta.editor_graph_asset_id,
      editorGeneratedAtText: appState.editorManifest.meta.generated_at,
      changedCount: appState.editorState.policyByContigId.size,
      routePolicyDocument: currentRoutePolicyDocument(),
      clearDisabled: !feature || isDefaultPolicy(policy),
    });
    mapView.renderSelectedContig(appState.selectedContigId);
  }

  function selectContig(contigId) {
    appState.selectedContigId = Number(contigId);
    shellView.clearError();
    renderShell();
  }

  function updateSelectedPolicy(partial) {
    if (appState.selectedContigId == null) {
      return;
    }
    const current = policyForContig(appState.editorState, appState.selectedContigId);
    setContigPolicy(appState.editorState, appState.selectedContigId, { ...current, ...partial });
    mapView.updateContigStyle(appState.selectedContigId);
    renderShell();
  }

  function exportRoutePolicy() {
    downloadJsonDocument(currentRoutePolicyDocument(), appState.assetUrls.routePolicyFilename);
  }

  async function importRoutePolicy(file) {
    appState.editorState = normalizeRoutePolicyDocument(await readJsonFile(file), mapView.getContigFeatures());
    appState.loadedRoutePolicyLabel = `imported/${file.name}`;
    mapView.updateAllContigStyles();
    renderShell();
  }

  async function boot() {
    const { editorManifest, assetUrls, waysGeojson, routePolicy } = await loadEditorBundle({
      editorManifestUrl,
      validateEditorManifest,
      pageUrl: window.location.href,
    });
    appState.editorManifest = editorManifest;
    appState.assetUrls = assetUrls;
    mapView.renderWays(waysGeojson);
    appState.editorState = normalizeRoutePolicyDocument(routePolicy, mapView.getContigFeatures());
    appState.loadedRoutePolicyLabel = canonicalRoutePolicyPath();
    renderShell();
  }

  return {
    boot,
  };
}
