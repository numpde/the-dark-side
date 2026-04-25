import {
  buildPatchsetDocument,
  defaultWayPolicy,
  normalizePatchset,
  policyForWay,
  setWayPolicy,
} from "./editor-state.mjs";

const waysUrl = new URL("./generated/karura-editor-network.geojson", window.location.href);
const patchesUrl = new URL("./source/karura-map-patches.json", window.location.href);

const exportButton = document.getElementById("export-button");
const importButton = document.getElementById("import-button");
const importInput = document.getElementById("import-input");
const wayHeading = document.getElementById("way-heading");
const wayMeta = document.getElementById("way-meta");
const bikeabilitySelect = document.getElementById("bikeability-select");
const directionSelect = document.getElementById("direction-select");
const availabilitySelect = document.getElementById("availability-select");
const changeCount = document.getElementById("change-count");
const clearButton = document.getElementById("clear-button");
const errorBox = document.getElementById("error-box");
const loadedPatchPath = document.getElementById("loaded-patch-path");
const exportHint = document.getElementById("export-hint");
const patchPreview = document.getElementById("patch-preview");
const stateButtons = [...document.querySelectorAll(".state-button")];

const appState = {
  map: null,
  visibleLayer: null,
  hitLayer: null,
  wayLayers: new Map(),
  wayFeatures: new Map(),
  selectedWayId: null,
  selectedOverlay: null,
  endpointLayer: null,
  editorState: normalizePatchset(null),
  loadedPatchLabel: "source/karura-map-patches.json",
};


function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}


function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}


async function fetchJson(url, fallback) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
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
  if (policy.availability === "temporarily_unavailable") {
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
    policy.availability === "default"
  );
}


function currentPatchDocument() {
  return buildPatchsetDocument(appState.editorState, appState.wayFeatures);
}


function updatePatchInfo() {
  loadedPatchPath.textContent = appState.loadedPatchLabel;
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
  availabilitySelect.disabled = disabled;
  availabilitySelect.value = policy.availability;
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
  downloadJson(currentPatchDocument(), "karura_map_patches.json");
  exportHint.innerHTML =
    'Export downloads a replacement for <code>web/source/karura-map-patches.json</code>.';
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
  const [waysGeojson, patchset] = await Promise.all([
    fetchJson(waysUrl),
    fetchJson(patchesUrl, {
      meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" },
      patches: [],
    }),
  ]);

  appState.editorState = normalizePatchset(patchset);
  appState.loadedPatchLabel = "source/karura-map-patches.json";
  renderWays(waysGeojson);
  updateControls();
}


stateButtons.forEach((button) => {
  button.addEventListener("click", () => {
    updateSelectedPolicy({ routingState: button.dataset.routingState });
  });
});

bikeabilitySelect.addEventListener("change", () => {
  updateSelectedPolicy({
    bikeability: bikeabilitySelect.value === "" ? null : Number(bikeabilitySelect.value),
  });
});

directionSelect.addEventListener("change", () => {
  updateSelectedPolicy({ bicycleDirection: directionSelect.value });
});

availabilitySelect.addEventListener("change", () => {
  updateSelectedPolicy({ availability: availabilitySelect.value });
});

clearButton.addEventListener("click", () => {
  if (appState.selectedWayId == null) {
    return;
  }
  setWayPolicy(appState.editorState, appState.selectedWayId, defaultWayPolicy());
  updateWayStyle(appState.selectedWayId);
  updateControls();
});

exportButton.addEventListener("click", exportPatchset);

importButton.addEventListener("click", () => importInput.click());

importInput.addEventListener("change", async () => {
  const [file] = importInput.files || [];
  if (!file) {
    return;
  }
  try {
    await importPatchset(file);
    clearError();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    importInput.value = "";
  }
});

boot().catch((error) => {
  showError(error instanceof Error ? error.message : String(error));
});
