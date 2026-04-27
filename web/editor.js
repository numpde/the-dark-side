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
};

function isCurrentlyUnavailable(policy) {
  return isPolicyCurrentlyUnavailable(
    { "local:unavailable_until": policy.unavailableUntil ?? undefined },
    karuraTodayString(),
  );
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return await response.json();
}

function waysUrlFromManifest() {
  const relativePath = appState.editorManifest.editor.network_path;
  const url = new URL(relativePath, editorManifestUrl);
  url.searchParams.set("v", appState.editorManifest.editor.network_version);
  return url;
}

function canonicalPatchPath() {
  return appState.editorManifest.meta.patchset_path;
}

function patchesUrlFromManifest() {
  const url = new URL(`./${canonicalPatchPath()}`, window.location.href);
  url.searchParams.set("v", appState.editorManifest.meta.patchset_digest);
  return url;
}

function canonicalPatchFilename() {
  const path = canonicalPatchPath();
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  if (!filename) {
    throw new Error(`Editor manifest has invalid meta.patchset_path: ${path}`);
  }
  return filename;
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
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportPatchset() {
  downloadJson(currentPatchDocument(), canonicalPatchFilename());
}

async function importPatchset(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  appState.editorState = normalizePatchset(parsed);
  appState.loadedPatchLabel = `imported/${file.name}`;
  mapView.updateAllWayStyles();
  renderShell();
}

async function boot() {
  appState.editorManifest = validateEditorManifest(
    await fetchJson(editorManifestUrl, { cache: "no-store" }),
  );
  const [waysGeojson, patchset] = await Promise.all([
    fetchJson(waysUrlFromManifest()),
    fetchJson(patchesUrlFromManifest()),
  ]);
  appState.editorState = normalizePatchset(patchset);
  appState.loadedPatchLabel = canonicalPatchPath();
  mapView.renderWays(waysGeojson);
  renderShell();
}

boot().catch((error) => {
  reportFatalError(error, "Failed to load editor");
});
