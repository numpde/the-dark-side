import {
  DATASET_URL,
  MAP_INTERACTION_CONFIG,
  MAP_WHEEL_ZOOM_DELTA_LIMIT,
  MAP_WHEEL_ZOOM_SENSITIVITY,
  MAX_MAP_ZOOM,
} from "./editor-config.js?v=20260427ac";
import { buildFitResult } from "./editor-fit.js?v=20260427ac";
import { createEditorStore } from "./editor-store.js?v=20260427ac";
import { createRenderer } from "./editor-render.js?v=20260427ac";

const dom = getDom();

const runtime = {
  imagePointer: {
    active: false,
    moved: false,
    suppressClick: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    originOffsetX: 0,
    originOffsetY: 0,
  },
};

boot().catch((error) => {
  console.error(error);
  if (error?.stack) {
    console.error(error.stack);
  }
  setStatus(`Failed to boot editor: ${error.message || String(error)}`);
});

async function boot() {
  const dataset = await loadDataset();
  const store = createEditorStore(dataset);
  const mapParts = initializeMap();
  let renderer = null;
  const actions = {
    selectPoint(pointId) {
      store.selectPoint(pointId);
      renderer.renderAll();
    },
    assignPointMap(pointId, latlng) {
      store.assignPointMap(pointId, latlng);
      renderer.renderAll();
    },
  };
  renderer = createRenderer({
    dom,
    map: mapParts.map,
    markerLayer: mapParts.markerLayer,
    store,
    actions,
  });

  populateFigureSelect(dataset.figures);
  syncUiControls(store);
  wireControls({ store, renderer, map: mapParts.map });
  bindImageViewportInteractions({ store, renderer });

  await renderer.loadCurrentFigureScene({ resetMapView: true });
  renderer.setStatus("Ready. Select or add a point, place it on both sides, then run fit.");
}

function getDom() {
  return {
    figureSelect: document.getElementById("figure-select"),
    fitMode: document.getElementById("fit-mode"),
    toggleRegion: document.getElementById("toggle-region"),
    toggleBounds: document.getElementById("toggle-bounds"),
    undoButton: document.getElementById("undo-button"),
    addPointButton: document.getElementById("add-point-button"),
    deletePointButton: document.getElementById("delete-point-button"),
    clearPointsButton: document.getElementById("clear-points-button"),
    fitButton: document.getElementById("fit-button"),
    figureMeta: document.getElementById("figure-meta"),
    selectionStrip: document.getElementById("selection-strip"),
    imageViewport: document.getElementById("image-viewport"),
    imageCanvas: document.getElementById("image-canvas"),
    screenshotImage: document.getElementById("screenshot-image"),
    imageMarkers: document.getElementById("image-markers"),
    imagePlacementGhost: document.getElementById("image-placement-ghost"),
    imagePlacementGhostIndex: document.getElementById("image-placement-ghost-index"),
    mapPlacementGhost: document.getElementById("map-placement-ghost"),
    mapPlacementGhostIndex: document.getElementById("map-placement-ghost-index"),
    pointList: document.getElementById("point-list"),
    copyFitButton: document.getElementById("copy-fit-button"),
    statusBox: document.getElementById("status-box"),
    resultBox: document.getElementById("result-box"),
  };
}

function initializeMap() {
  const markerLayer = L.layerGroup();
  const map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    maxZoom: MAX_MAP_ZOOM,
    ...MAP_INTERACTION_CONFIG,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 20,
    maxZoom: MAX_MAP_ZOOM,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  window.__stravaFitMap = map;
  markerLayer.addTo(map);
  bindMapWheelZoom(map);
  return { map, markerLayer };
}

function bindMapWheelZoom(map) {
  const mapContainer = map.getContainer();
  mapContainer.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const deltaUnits = normalizeWheelDelta(event);
      const deltaZoom = clamp(-deltaUnits * MAP_WHEEL_ZOOM_SENSITIVITY, -MAP_WHEEL_ZOOM_DELTA_LIMIT, MAP_WHEEL_ZOOM_DELTA_LIMIT);
      if (!deltaZoom) {
        return;
      }
      const nextZoom = clamp(map.getZoom() + deltaZoom, map.getMinZoom(), map.getMaxZoom());
      map.setZoomAround(L.point(event.offsetX, event.offsetY), nextZoom);
    },
    { passive: false }
  );
}

function populateFigureSelect(figures) {
  dom.figureSelect.innerHTML = "";
  for (const figure of figures) {
    const option = document.createElement("option");
    option.value = figure.id;
    option.textContent = `${figure.label} · ${figure.fileName}`;
    dom.figureSelect.append(option);
  }
}

function syncUiControls(store) {
  const uiState = store.getUiState();
  dom.figureSelect.value = uiState.figureId ?? "";
  dom.fitMode.value = store.getFitMode().key;
  dom.toggleRegion.checked = uiState.showRegion;
  dom.toggleBounds.checked = uiState.showBounds;
}

function wireControls({ store, renderer, map }) {
  dom.figureSelect.addEventListener("change", async () => {
    store.setFigureId(dom.figureSelect.value);
    await renderer.loadCurrentFigureScene({ resetMapView: true });
  });

  dom.fitMode.addEventListener("change", () => {
    store.setFitMode(dom.fitMode.value);
    renderer.renderAll();
  });

  dom.toggleRegion.addEventListener("change", () => {
    store.setShowRegion(dom.toggleRegion.checked);
    renderer.syncOverlayVisibility();
  });

  dom.toggleBounds.addEventListener("change", () => {
    store.setShowBounds(dom.toggleBounds.checked);
    renderer.syncOverlayVisibility();
  });

  dom.addPointButton.addEventListener("click", () => {
    store.addPoint();
    renderer.renderAll();
  });

  dom.undoButton.addEventListener("click", () => {
    triggerUndo({ store, renderer });
  });

  dom.deletePointButton.addEventListener("click", () => {
    store.deleteSelectedPoint();
    renderer.renderAll();
  });

  dom.clearPointsButton.addEventListener("click", () => {
    if (!confirmResetPoints(store)) {
      return;
    }
    store.clearCurrentFigurePoints();
    renderer.renderAll();
    renderer.setStatus("Figure points and fit reset.");
  });

  dom.fitButton.addEventListener("click", () => {
    runFit({ store, renderer });
  });

  dom.copyFitButton.addEventListener("click", async () => {
    await copyFitResult(renderer);
  });

  map.on("click", (event) => {
    store.assignSelectedPointMap(event.latlng);
    renderer.renderAll();
  });

  window.addEventListener("resize", () => {
    store.ensureImageViewForCurrentFigure(dom.imageViewport);
    renderer.renderImageStage();
    renderer.invalidateMapSize();
  });

  window.addEventListener("keydown", (event) => {
    if (!isUndoShortcut(event) || isTypingTarget(event.target)) {
      return;
    }
    event.preventDefault();
    triggerUndo({ store, renderer });
  });
}

function bindImageViewportInteractions({ store, renderer }) {
  dom.imageViewport.addEventListener(
    "wheel",
    (event) => {
      const figure = store.getCurrentFigure();
      if (!figure) {
        return;
      }
      const imageView = store.ensureImageViewForCurrentFigure(dom.imageViewport);
      if (!imageView) {
        return;
      }
      event.preventDefault();
      const rect = dom.imageViewport.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const imageX = (pointerX - imageView.offsetX) / imageView.scale;
      const imageY = (pointerY - imageView.offsetY) / imageView.scale;
      const zoomFactor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = clamp(imageView.scale * zoomFactor, 0.15, 6);
      store.updateCurrentImageView((view) => {
        view.offsetX = pointerX - imageX * nextScale;
        view.offsetY = pointerY - imageY * nextScale;
        view.scale = nextScale;
      }, { persist: true });
      renderer.renderImageStage();
    },
    { passive: false }
  );

  dom.imageViewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const imageView = store.ensureImageViewForCurrentFigure(dom.imageViewport);
    if (!imageView) {
      return;
    }
    runtime.imagePointer.active = true;
    runtime.imagePointer.moved = false;
    runtime.imagePointer.pointerId = event.pointerId;
    runtime.imagePointer.startX = event.clientX;
    runtime.imagePointer.startY = event.clientY;
    runtime.imagePointer.originOffsetX = imageView.offsetX;
    runtime.imagePointer.originOffsetY = imageView.offsetY;
    runtime.imagePointer.suppressClick = false;
    dom.imageViewport.setPointerCapture(event.pointerId);
    dom.imageViewport.classList.add("is-panning");
  });

  dom.imageViewport.addEventListener("pointermove", (event) => {
    if (!runtime.imagePointer.active || runtime.imagePointer.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - runtime.imagePointer.startX;
    const dy = event.clientY - runtime.imagePointer.startY;
    const wasMoved = runtime.imagePointer.moved;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      runtime.imagePointer.moved = true;
    }
    if (!wasMoved && runtime.imagePointer.moved) {
      renderer.setImagePlacementPreviewNavigating(true);
    }
    if (!runtime.imagePointer.moved) {
      return;
    }
    store.updateCurrentImageView((imageView) => {
      imageView.offsetX = runtime.imagePointer.originOffsetX + dx;
      imageView.offsetY = runtime.imagePointer.originOffsetY + dy;
    });
    renderer.renderImageStage();
  });

  const finishPointer = (event) => {
    if (!runtime.imagePointer.active || runtime.imagePointer.pointerId !== event.pointerId) {
      return;
    }
    if (dom.imageViewport.hasPointerCapture(event.pointerId)) {
      dom.imageViewport.releasePointerCapture(event.pointerId);
    }
    dom.imageViewport.classList.remove("is-panning");
    const wasMoved = runtime.imagePointer.moved;
    runtime.imagePointer.active = false;
    runtime.imagePointer.pointerId = null;
    runtime.imagePointer.suppressClick = wasMoved;
    renderer.setImagePlacementPreviewNavigating(false);
    if (wasMoved) {
      store.persistState();
    }
  };

  dom.imageViewport.addEventListener("pointerup", finishPointer);
  dom.imageViewport.addEventListener("pointercancel", finishPointer);
  dom.imageViewport.addEventListener("click", (event) => {
    if (runtime.imagePointer.suppressClick) {
      runtime.imagePointer.suppressClick = false;
      return;
    }
    placeImagePointFromPointerEvent(event, { store, renderer });
  });
}

function placeImagePointFromPointerEvent(event, { store, renderer }) {
  if (!dom.screenshotImage.complete) {
    return;
  }
  const figure = store.getCurrentFigure();
  const imageView = store.ensureImageViewForCurrentFigure(dom.imageViewport);
  if (!figure || !imageView) {
    return;
  }
  const rect = dom.imageViewport.getBoundingClientRect();
  const imageX = (event.clientX - rect.left - imageView.offsetX) / imageView.scale;
  const imageY = (event.clientY - rect.top - imageView.offsetY) / imageView.scale;
  if (imageX < 0 || imageY < 0 || imageX > figure.imageSize.width || imageY > figure.imageSize.height) {
    return;
  }
  store.assignSelectedPointImage(imageX, imageY);
  renderer.renderAll();
}

function runFit({ store, renderer }) {
  const figure = store.getCurrentFigure();
  const points = store.getPairedPoints();
  const fitMode = store.getFitMode();

  if (!figure || points.length < fitMode.minControlPoints) {
    renderer.setStatus(`${fitMode.label} fit needs at least ${store.formatCount(fitMode.minControlPoints, "fully paired point")}.`);
    return;
  }

  try {
    const fit = fitMode.solve(points);
    const fitResult = buildFitResult({
      figure,
      fitModeKey: fitMode.key,
      fit,
      points,
    });
    store.setCurrentFit(fitResult);
    renderer.renderAll();
    renderer.setStatus(`Fit complete. ${store.formatCount(points.length, "paired point")}, mean residual ${fitResult.output.residualSummaryMeters.mean} m.`);
  } catch (error) {
    console.error(error);
    renderer.setStatus(`Fit failed: ${error.message || String(error)}`);
  }
}

async function copyFitResult(renderer) {
  const fitText = dom.resultBox.textContent || "";
  if (!fitText.trim()) {
    renderer.setStatus("No fit result to copy.");
    return;
  }
  try {
    await navigator.clipboard.writeText(fitText);
    renderer.setStatus("Fit result copied to clipboard.");
  } catch (error) {
    console.error(error);
    renderer.setStatus(`Copy failed: ${error.message || String(error)}`);
  }
}

function triggerUndo({ store, renderer }) {
  if (!store.undoCurrentFigureState()) {
    renderer.setStatus("Nothing to undo for this figure.");
    return;
  }
  renderer.renderAll();
  renderer.setStatus("Undo applied.");
}

function confirmResetPoints(store) {
  const figure = store.getCurrentFigure();
  const figureState = store.getCurrentFigureState();
  const pointCount = figureState.points.length;
  const hasFit = !!store.getCurrentFit();
  const parts = [];
  if (pointCount) {
    parts.push(store.formatCount(pointCount, "control point"));
  }
  if (hasFit) {
    parts.push("the current fit result");
  }
  if (!parts.length) {
    return false;
  }
  const figureLabel = figure?.label ?? "this figure";
  return window.confirm(`Reset ${figureLabel}?\n\nThis will remove ${parts.join(" and ")}.`);
}

function isUndoShortcut(event) {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName);
}

async function loadDataset() {
  const response = await fetch(DATASET_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load dataset: ${response.status}`);
  }
  return response.json();
}

function setStatus(message) {
  dom.statusBox.textContent = message;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeWheelDelta(event) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 18;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * 120;
  }
  return event.deltaY;
}
