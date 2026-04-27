const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Editor runtime");
const {
  buildPatchsetDocument,
  defaultWayPolicy,
  emptyPatchset,
  normalizePatchset,
  policyForWay,
  setWayPolicy,
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

function findErrorBox() {
  return document.getElementById("error-box");
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function reportFatalError(error, context = "Editor error") {
  const message = `${context}: ${formatError(error)}`;
  console.error(message, error);
  const box = findErrorBox();
  if (box) {
    box.textContent = message;
    box.classList.remove("hidden");
  }
}

window.addEventListener("error", (event) => {
  reportFatalError(event.error ?? event.message, "Page error");
});

window.addEventListener("unhandledrejection", (event) => {
  reportFatalError(event.reason, "Unhandled promise rejection");
});

const editorManifestUrl = new URL("./generated/editor-manifest.json", window.location.href);

const appState = {
  selectedWayId: null,
  editorState: normalizePatchset(emptyPatchset()),
  loadedPatchLabel: "–",
  editorManifest: null,
  assetUrls: null,
};

function isCurrentlyUnavailable(policy) {
  return isPolicyCurrentlyUnavailable(
    { "local:unavailable_until": policy.unavailableUntil ?? undefined },
    karuraTodayString(),
  );
}

function canonicalPatchPath() {
  return appState.assetUrls.patchsetPath;
}

const mapView = createEditorMapView({
  mapElementId: "map",
  onSelectWay: (wayId) => selectWay(wayId),
  resolveFeatureStyle: (feature) => styleForPolicy(
    policyForWay(appState.editorState, feature.properties.contig_id),
    isCurrentlyUnavailable,
  ),
});

const shellView = createEditorShellView({
  reportError: reportFatalError,
  onRoutingStateChange: (routingState) => updateSelectedPolicy({ routingState }),
  onBikeabilityChange: (bikeability) => updateSelectedPolicy({ bikeability }),
  onDirectionChange: (bicycleDirection) => updateSelectedPolicy({ bicycleDirection }),
  onUnavailableUntilChange: (unavailableUntil) => updateSelectedPolicy({ unavailableUntil }),
  onClear: () => {
    if (appState.selectedWayId == null) {
      return;
    }
    setWayPolicy(appState.editorState, appState.selectedWayId, defaultWayPolicy());
    mapView.updateWayStyle(appState.selectedWayId);
    shellView.clearError();
    renderShell();
  },
  onExport: () => exportPatchset(),
  onImportFile: async (file) => {
    await importPatchset(file);
    shellView.clearError();
  },
});

function isDefaultPolicy(policy) {
  return (
    policy.routingState === "default" &&
    policy.bikeability == null &&
    policy.bicycleDirection === "both" &&
    policy.unavailableUntil == null
  );
}

function currentPatchDocument() {
  return buildPatchsetDocument(appState.editorState, mapView.getWayFeatures());
}

function renderShell() {
  const feature = mapView.featureForWay(appState.selectedWayId);
  const policy = feature
    ? policyForWay(appState.editorState, appState.selectedWayId)
    : defaultWayPolicy();

  shellView.update({
    feature,
    policy,
    loadedPatchLabel: appState.loadedPatchLabel,
    canonicalPatchPath: canonicalPatchPath(),
    editorGraphAssetId: appState.editorManifest.meta.editor_graph_asset_id,
    editorGeneratedAtText: appState.editorManifest.meta.generated_at,
    changedCount: appState.editorState.policyByWayId.size,
    patchDocument: currentPatchDocument(),
    clearDisabled: !feature || isDefaultPolicy(policy),
  });
  mapView.renderSelectedWay(appState.selectedWayId);
}

function selectWay(wayId) {
  appState.selectedWayId = Number(wayId);
  shellView.clearError();
  renderShell();
}

function updateSelectedPolicy(partial) {
  if (appState.selectedWayId == null) {
    return;
  }
  const current = policyForWay(appState.editorState, appState.selectedWayId);
  setWayPolicy(appState.editorState, appState.selectedWayId, { ...current, ...partial });
  mapView.updateWayStyle(appState.selectedWayId);
  renderShell();
}

function downloadJson(payload, filename) {
  downloadJsonDocument(payload, filename);
}

function exportPatchset() {
  downloadJson(currentPatchDocument(), appState.assetUrls.patchsetFilename);
}

async function importPatchset(file) {
  appState.editorState = normalizePatchset(await readJsonFile(file));
  appState.loadedPatchLabel = `imported/${file.name}`;
  mapView.updateAllWayStyles();
  renderShell();
}

async function boot() {
  const { editorManifest, assetUrls, waysGeojson, patchset } = await loadEditorBundle({
    editorManifestUrl,
    validateEditorManifest,
    pageUrl: window.location.href,
  });
  appState.editorManifest = editorManifest;
  appState.assetUrls = assetUrls;
  appState.editorState = normalizePatchset(patchset);
  appState.loadedPatchLabel = canonicalPatchPath();
  mapView.renderWays(waysGeojson);
  renderShell();
}

boot().catch((error) => {
  reportFatalError(error, "Failed to load editor");
});
