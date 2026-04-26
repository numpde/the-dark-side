function requireModuleVersion() {
  const version = new URL(import.meta.url).searchParams.get("v");
  if (!version) {
    throw new Error("Editor runtime is missing required module version");
  }
  return version;
}

const MODULE_VERSION = requireModuleVersion();
const moduleSuffix = `?v=${encodeURIComponent(MODULE_VERSION)}`;
const {
  buildPatchsetDocument,
  emptyPatchset,
  defaultWayPolicy,
  normalizePatchset,
  policyForWay,
  setWayPolicy,
} = await import(`./editor-state.mjs${moduleSuffix}`);
const {
  karuraTodayString,
  isCurrentlyUnavailable: isPolicyCurrentlyUnavailable,
} = await import(`./karura-policy.mjs${moduleSuffix}`);
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

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    const message = `Missing required page element: #${id}`;
    const fallbackErrorBox = findErrorBox();
    if (fallbackErrorBox) {
      fallbackErrorBox.textContent = message;
      fallbackErrorBox.classList.remove("hidden");
    }
    console.error(message);
    throw new Error(message);
  }
  return element;
}


const editorManifestUrl = new URL("./generated/editor-manifest.json", window.location.href);

const exportButton = requireElement("export-button");
const importButton = requireElement("import-button");
const importInput = requireElement("import-input");
const wayHeading = requireElement("way-heading");
const wayMeta = requireElement("way-meta");
const bikeabilitySelect = requireElement("bikeability-select");
const directionSelect = requireElement("direction-select");
const unavailableUntilInput = requireElement("unavailable-until-input");
const changeCount = requireElement("change-count");
const clearButton = requireElement("clear-button");
const errorBox = requireElement("error-box");
const loadedPatchPath = requireElement("loaded-patch-path");
const exportTargetPath = requireElement("export-target-path");
const editorGraphAsset = requireElement("editor-graph-asset");
const editorGeneratedAt = requireElement("editor-generated-at");
const exportHint = requireElement("export-hint");
const patchPreview = requireElement("patch-preview");
const stateButtons = [...document.querySelectorAll(".state-button")];
if (stateButtons.length === 0) {
  reportFatalError("Missing required state buttons", "Failed to load editor");
  throw new Error("Missing required state buttons");
}

const appState = {
  map: null,
  visibleLayer: null,
  hitLayer: null,
  wayLayers: new Map(),
  wayFeatures: new Map(),
  selectedWayId: null,
  selectedOverlay: null,
  endpointLayer: null,
  editorState: normalizePatchset(emptyPatchset()),
  loadedPatchLabel: "–",
  editorManifest: null,
};


function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}


function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}


function guard(fn, context) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      reportFatalError(error, context);
      return undefined;
    }
  };
}


function guardAsync(fn, context) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      reportFatalError(error, context);
      return undefined;
    }
  };
}


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


function ensureMap() {
  if (appState.map) {
    return appState.map;
  }
  const map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  });
  map.setView([-1.2418, 36.8315], 14);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
  appState.map = map;
  return map;
}


function styleForPolicy(policy) {
  const bikeability = policy.bikeability == null ? 0 : Number(policy.bikeability);
  const extraWeight = Math.max(0, bikeability - 1) * 0.5;
  if (isCurrentlyUnavailable(policy)) {
    return {
      color: "#c07a2d",
      weight: 4 + extraWeight,
      opacity: 0.9,
      dashArray: "8 6",
    };
  }
  if (policy.routingState === "include") {
    return {
      color: "#2d8c4d",
      weight: 4 + extraWeight,
      opacity: 0.9,
    };
  }
  if (policy.routingState === "exclude") {
    return {
      color: "#bf3a34",
      weight: 4 + extraWeight,
      opacity: 0.88,
      dashArray: "10 7",
    };
  }
  if (policy.bikeability != null || policy.bicycleDirection !== "both") {
    return {
      color: "#315b72",
      weight: 3.4 + extraWeight,
      opacity: 0.8,
    };
  }
  return {
    color: "#3d4f46",
    weight: 3,
    opacity: 0.55,
  };
}


function wayStyle(feature) {
  return styleForPolicy(policyForWay(appState.editorState, feature.properties.contig_id));
}


function updateWayStyle(wayId) {
  const layer = appState.wayLayers.get(Number(wayId));
  const feature = appState.wayFeatures.get(Number(wayId));
  if (!layer || !feature) {
    return;
  }
  layer.setStyle(wayStyle(feature));
}


function updateAllWayStyles() {
  for (const wayId of appState.wayLayers.keys()) {
    updateWayStyle(wayId);
  }
}


function geometryEndpoints(feature) {
  const geometry = feature.geometry;
  if (!geometry) {
    return { first: null, last: null };
  }
  if (geometry.type === "LineString") {
    return {
      first: geometry.coordinates[0],
      last: geometry.coordinates[geometry.coordinates.length - 1],
    };
  }
  if (geometry.type === "MultiLineString" && geometry.coordinates.length) {
    const firstLine = geometry.coordinates[0];
    const lastLine = geometry.coordinates[geometry.coordinates.length - 1];
    return {
      first: firstLine[0],
      last: lastLine[lastLine.length - 1],
    };
  }
  return { first: null, last: null };
}


function endpointMarker(lat, lon, label) {
  return L.marker([lat, lon], {
    icon: L.divIcon({
      className: "",
      html: `<div class="endpoint-chip">${label}</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    }),
    keyboard: false,
  });
}


function renderSelectedWay() {
  const map = ensureMap();
  if (appState.selectedOverlay) {
    appState.selectedOverlay.remove();
  }
  if (appState.endpointLayer) {
    appState.endpointLayer.remove();
  }

  const feature = appState.wayFeatures.get(appState.selectedWayId);
  if (!feature) {
    return;
  }

  const policy = policyForWay(appState.editorState, appState.selectedWayId);
  const baseStyle = styleForPolicy(policy);
  const overlay = L.layerGroup();
  L.geoJSON(feature, {
    style: {
      color: "#ffffff",
      weight: baseStyle.weight + 5,
      opacity: 0.95,
    },
  }).addTo(overlay);
  L.geoJSON(feature, {
    style: {
      ...baseStyle,
      weight: baseStyle.weight + 1,
      opacity: 1,
    },
  }).addTo(overlay);
  overlay.addTo(map);
  appState.selectedOverlay = overlay;

  const { first, last } = geometryEndpoints(feature);
  if (first && last) {
    const endpointLayer = L.layerGroup();
    endpointMarker(first[1], first[0], "1").addTo(endpointLayer);
    endpointMarker(last[1], last[0], "2").addTo(endpointLayer);
    endpointLayer.addTo(map);
    appState.endpointLayer = endpointLayer;
  }
}


function updateChangeCount() {
  changeCount.textContent = `${appState.editorState.policyByWayId.size} changed`;
}

function isDefaultPolicy(policy) {
  return (
    policy.routingState === "default" &&
    policy.bikeability == null &&
    policy.bicycleDirection === "both" &&
    policy.unavailableUntil == null
  );
}


function currentPatchDocument() {
  return buildPatchsetDocument(appState.editorState, appState.wayFeatures);
}


function updatePatchInfo() {
  loadedPatchPath.textContent = appState.loadedPatchLabel;
  exportTargetPath.textContent = canonicalPatchPath();
  exportHint.innerHTML =
    `Export downloads a replacement for <code>${canonicalPatchPath()}</code>.`;
  editorGraphAsset.textContent = appState.editorManifest.meta.editor_graph_asset_id;
  editorGeneratedAt.textContent = appState.editorManifest.meta.generated_at;
  patchPreview.textContent = `${JSON.stringify(currentPatchDocument(), null, 2)}\n`;
}


function updateControls() {
  const feature = appState.wayFeatures.get(appState.selectedWayId);
  const disabled = !feature;
  const policy = feature
    ? policyForWay(appState.editorState, appState.selectedWayId)
    : defaultWayPolicy();

  wayHeading.textContent = feature
    ? feature.properties.way_names?.[0] || `Contig ${feature.properties.contig_id}`
    : "Select a contig";
  wayMeta.textContent = feature
    ? `#${feature.properties.contig_id} · ${Math.round(feature.properties.length_m)} m · ways ${feature.properties.way_ids.join(", ")}`
    : "";

  for (const button of stateButtons) {
    button.disabled = disabled;
    button.classList.toggle("is-active", policy.routingState === button.dataset.routingState);
  }
  bikeabilitySelect.disabled = disabled;
  bikeabilitySelect.value = policy.bikeability == null ? "" : String(policy.bikeability);
  directionSelect.disabled = disabled;
  directionSelect.value = policy.bicycleDirection;
  unavailableUntilInput.disabled = disabled;
  unavailableUntilInput.value = policy.unavailableUntil ?? "";
  clearButton.disabled = disabled || isDefaultPolicy(policy);
  updateChangeCount();
  updatePatchInfo();
  renderSelectedWay();
}


function selectWay(wayId) {
  appState.selectedWayId = Number(wayId);
  clearError();
  updateControls();
}


function updateSelectedPolicy(partial) {
  if (appState.selectedWayId == null) {
    return;
  }
  const current = policyForWay(appState.editorState, appState.selectedWayId);
  setWayPolicy(appState.editorState, appState.selectedWayId, { ...current, ...partial });
  updateWayStyle(appState.selectedWayId);
  updateControls();
}


function renderWays(geojson) {
  const map = ensureMap();
  appState.wayLayers.clear();
  appState.wayFeatures.clear();
  if (appState.visibleLayer) {
    appState.visibleLayer.remove();
  }
  if (appState.hitLayer) {
    appState.hitLayer.remove();
  }

  const visibleLayer = L.geoJSON(geojson, {
    style: wayStyle,
    interactive: false,
    onEachFeature(feature, layer) {
      const wayId = Number(feature.properties.contig_id);
      appState.wayLayers.set(wayId, layer);
      appState.wayFeatures.set(wayId, feature);
    },
  }).addTo(map);

  const hitLayer = L.geoJSON(geojson, {
    style: {
      color: "#000000",
      weight: 16,
      opacity: 0.01,
    },
    onEachFeature(feature, layer) {
      const wayId = Number(feature.properties.contig_id);
      layer.on("click", () => selectWay(wayId));
    },
  }).addTo(map);
  appState.visibleLayer = visibleLayer;
  appState.hitLayer = hitLayer;
  map.fitBounds(hitLayer.getBounds(), { padding: [24, 24], maxZoom: 16 });
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
  updateAllWayStyles();
  updateControls();
}


async function boot() {
  const editorManifest = validateEditorManifest(
    await fetchJson(editorManifestUrl, { cache: "no-store" })
  );
  appState.editorManifest = editorManifest;
  const [waysGeojson, patchset] = await Promise.all([
    fetchJson(waysUrlFromManifest()),
    fetchJson(patchesUrlFromManifest()),
  ]);

  appState.editorState = normalizePatchset(patchset);
  appState.loadedPatchLabel = canonicalPatchPath();
  renderWays(waysGeojson);
  updateControls();
}


stateButtons.forEach((button) => {
  button.addEventListener("click", guard(() => {
    updateSelectedPolicy({ routingState: button.dataset.routingState });
  }, "Failed to update routing state"));
});

bikeabilitySelect.addEventListener("change", guard(() => {
  updateSelectedPolicy({
    bikeability: bikeabilitySelect.value === "" ? null : Number(bikeabilitySelect.value),
  });
}, "Failed to update bikeability"));

directionSelect.addEventListener("change", guard(() => {
  updateSelectedPolicy({ bicycleDirection: directionSelect.value });
}, "Failed to update direction"));

unavailableUntilInput.addEventListener("change", guard(() => {
  updateSelectedPolicy({ unavailableUntil: unavailableUntilInput.value || null });
}, "Failed to update availability"));

clearButton.addEventListener("click", guard(() => {
  if (appState.selectedWayId == null) {
    return;
  }
  setWayPolicy(appState.editorState, appState.selectedWayId, defaultWayPolicy());
  updateWayStyle(appState.selectedWayId);
  updateControls();
}, "Failed to reset contig policy"));

exportButton.addEventListener("click", guard(exportPatchset, "Failed to export patch file"));

importButton.addEventListener("click", guard(() => importInput.click(), "Failed to open import dialog"));

importInput.addEventListener("change", guardAsync(async () => {
  const [file] = importInput.files || [];
  if (!file) {
    return;
  }
  try {
    await importPatchset(file);
    clearError();
  } finally {
    importInput.value = "";
  }
}, "Failed to import patch file"));

guardAsync(boot, "Failed to load editor")();
