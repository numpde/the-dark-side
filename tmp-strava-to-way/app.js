import {
  DATASET_URL,
  MAP_INTERACTION_CONFIG,
  MAP_WHEEL_ZOOM_DELTA_LIMIT,
  MAP_WHEEL_ZOOM_SENSITIVITY,
  MAX_MAP_ZOOM,
  TRACE_WAY_TAG_FIELDS,
} from "./editor-config.js?v=20260427aw";
import { buildFitResult } from "./editor-fit.js?v=20260427aw";
import { createEditorStore } from "./editor-store.js?v=20260427aw";
import { createRenderer } from "./editor-render.js?v=20260427aw";

const dom = getDom();

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
    selectTraceWay(wayId) {
      store.selectTraceWay(wayId);
      renderer.renderAll();
    },
    selectTraceVertex(wayId, vertexId) {
      store.selectTraceVertex(wayId, vertexId);
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
  populateTraceWayTagControls();
  syncUiControls(store);
  wireControls({ store, renderer, map: mapParts.map });
  bindImageViewportInteractions({ store, renderer });
  bindTraceViewportInteractions({ store, renderer });

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
    traceViewport: document.getElementById("trace-viewport"),
    traceCanvas: document.getElementById("trace-canvas"),
    traceImage: document.getElementById("trace-image"),
    traceOverlay: document.getElementById("trace-overlay"),
    tracePlacementGhost: document.getElementById("trace-placement-ghost"),
    tracePlacementGhostIndex: document.getElementById("trace-placement-ghost-index"),
    mapPlacementGhost: document.getElementById("map-placement-ghost"),
    mapPlacementGhostIndex: document.getElementById("map-placement-ghost-index"),
    pointList: document.getElementById("point-list"),
    addWayButton: document.getElementById("add-way-button"),
    deleteWayButton: document.getElementById("delete-way-button"),
    deleteVertexButton: document.getElementById("delete-vertex-button"),
    wayList: document.getElementById("way-list"),
    traceWayPreset: document.getElementById("trace-way-preset"),
    traceWayHighway: document.getElementById("trace-way-highway"),
    traceWayFoot: document.getElementById("trace-way-foot"),
    traceWayBicycle: document.getElementById("trace-way-bicycle"),
    traceWayMtbScale: document.getElementById("trace-way-mtb-scale"),
    traceTagStatusBox: document.getElementById("trace-tag-status-box"),
    copyTraceExportButton: document.getElementById("copy-trace-export-button"),
    traceStatusBox: document.getElementById("trace-status-box"),
    traceExportBox: document.getElementById("trace-export-box"),
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

function populateTraceWayTagControls() {
  const fieldSelectMap = {
    highway: dom.traceWayHighway,
    foot: dom.traceWayFoot,
    bicycle: dom.traceWayBicycle,
    mtbScale: dom.traceWayMtbScale,
  };
  for (const field of TRACE_WAY_TAG_FIELDS) {
    const select = fieldSelectMap[field.key];
    if (!select) {
      continue;
    }
    select.innerHTML = "";
    for (const optionDef of field.options) {
      const option = document.createElement("option");
      option.value = optionDef.value;
      option.textContent = optionDef.label;
      select.append(option);
    }
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

  dom.addWayButton.addEventListener("click", () => {
    store.addTraceWay();
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

  dom.deleteWayButton.addEventListener("click", () => {
    store.deleteSelectedTraceWay();
    renderer.renderAll();
  });

  dom.deleteVertexButton.addEventListener("click", () => {
    store.deleteSelectedTraceVertex();
    renderer.renderAll();
  });

  dom.traceWayPreset.addEventListener("change", () => {
    store.applySelectedTraceWayPreset(dom.traceWayPreset.value);
    renderer.renderAll();
  });

  const syncSelectedTraceWayTags = () => {
    store.updateSelectedTraceWayTags({
      highway: dom.traceWayHighway.value,
      foot: dom.traceWayFoot.value,
      bicycle: dom.traceWayBicycle.value,
      mtbScale: dom.traceWayMtbScale.value,
    });
    renderer.renderAll();
  };
  dom.traceWayHighway.addEventListener("change", syncSelectedTraceWayTags);
  dom.traceWayFoot.addEventListener("change", syncSelectedTraceWayTags);
  dom.traceWayBicycle.addEventListener("change", syncSelectedTraceWayTags);
  dom.traceWayMtbScale.addEventListener("change", syncSelectedTraceWayTags);

  dom.copyFitButton.addEventListener("click", async () => {
    await copyFitResult(renderer);
  });

  dom.copyTraceExportButton.addEventListener("click", async () => {
    await copyTraceExport(renderer);
  });

  map.on("click", (event) => {
    store.assignSelectedPointMap(event.latlng);
    renderer.renderAll();
  });

  window.addEventListener("resize", () => {
    store.ensureImageViewForCurrentFigure(dom.imageViewport);
    store.ensureTraceViewForCurrentFigure(dom.traceViewport);
    renderer.renderImageStage();
    renderer.renderTraceStage();
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
  bindViewportWheelZoom({
    viewportElement: dom.imageViewport,
    ensureView: () => store.ensureImageViewForCurrentFigure(dom.imageViewport),
    updateView: (mutator, options) => store.updateCurrentImageView(mutator, options),
    renderStage: () => renderer.renderImageStage(),
  });
  bindViewportPointerController({
    viewportElement: dom.imageViewport,
    ensureView: () => store.ensureImageViewForCurrentFigure(dom.imageViewport),
    updateView: (mutator) => store.updateCurrentImageView(mutator),
    persistState: () => store.persistState(),
    renderPanFrame: () => renderer.renderImageStage(),
    renderMutationFrame: () => renderer.renderAll(),
    setPreviewNavigating: (navigating) => renderer.setImagePlacementPreviewNavigating(navigating),
    placeFromClick: (event) => {
      placeImagePointFromPointerEvent(event, { store, renderer });
    },
  });
}

function bindTraceViewportInteractions({ store, renderer }) {
  bindViewportWheelZoom({
    viewportElement: dom.traceViewport,
    ensureView: () => store.ensureTraceViewForCurrentFigure(dom.traceViewport),
    updateView: (mutator, options) => store.updateCurrentTraceView(mutator, options),
    renderStage: () => renderer.renderTraceStage(),
  });
  bindViewportPointerController({
    viewportElement: dom.traceViewport,
    ensureView: () => store.ensureTraceViewForCurrentFigure(dom.traceViewport),
    updateView: (mutator) => store.updateCurrentTraceView(mutator),
    persistState: () => store.persistState(),
    renderPanFrame: () => renderer.renderTraceStage(),
    renderMutationFrame: () => renderer.renderAll(),
    setPreviewNavigating: (navigating) => renderer.setTracePlacementPreviewNavigating(navigating),
    resolveDragTarget: (event) => {
      const target = getTraceTarget(event.target);
      if (target?.kind !== "vertex") {
        return null;
      }
      return target;
    },
    selectDragTarget: (target) => {
      store.selectTraceVertex(target.wayId, target.vertexId);
    },
    moveDragTarget: (target, event, dragState) => {
      const placement = renderer.resolveTracePlacement(
        getViewportPoint(event, dom.traceViewport),
        buildTracePlacementContext(store, {
          wayId: target.wayId,
          vertexId: target.vertexId,
        })
      );
      if (!placement) {
        return false;
      }
      store.assignTraceVertex(target.wayId, target.vertexId, placement, {
        history: !dragState.historyCaptured,
        persist: false,
      });
      dragState.historyCaptured = true;
      return true;
    },
    handleTargetClick: (event) => {
      const target = getTraceTarget(event.target);
      if (target?.kind === "vertex") {
        store.selectTraceVertex(target.wayId, target.vertexId);
        renderer.renderAll();
        return true;
      }
      if (target?.kind === "way") {
        store.selectTraceWay(target.wayId);
        renderer.renderAll();
        return true;
      }
      return false;
    },
    placeFromClick: (event) => {
      placeTraceVertexFromPointerEvent(event, { store, renderer });
    },
  });
}

function bindViewportPointerController({
  viewportElement,
  ensureView,
  updateView,
  persistState,
  renderPanFrame,
  renderMutationFrame,
  setPreviewNavigating,
  resolveDragTarget = () => null,
  selectDragTarget = () => {},
  moveDragTarget = () => false,
  handleTargetClick = () => false,
  placeFromClick,
}) {
  const dragState = createViewportDragState();

  viewportElement.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const view = ensureView();
    if (!view) {
      return;
    }
    const dragTarget = resolveDragTarget(event);
    dragState.active = true;
    dragState.moved = false;
    dragState.suppressClick = false;
    dragState.pointerId = event.pointerId;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    dragState.originOffsetX = view.offsetX;
    dragState.originOffsetY = view.offsetY;
    dragState.historyCaptured = false;
    dragState.target = dragTarget;
    dragState.mode = dragTarget ? "target-drag" : "pan";
    if (dragTarget) {
      selectDragTarget(dragTarget);
      renderMutationFrame();
    }
    event.preventDefault();
    viewportElement.setPointerCapture(event.pointerId);
    viewportElement.classList.add("is-panning");
  });

  viewportElement.addEventListener("pointermove", (event) => {
    if (!dragState.active || dragState.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    const wasMoved = dragState.moved;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      dragState.moved = true;
    }
    if (!wasMoved && dragState.moved) {
      setPreviewNavigating(true);
    }
    if (!dragState.moved) {
      return;
    }
    event.preventDefault();
    if (dragState.mode === "target-drag") {
      const didMoveTarget = moveDragTarget(dragState.target, event, dragState);
      if (didMoveTarget) {
        renderMutationFrame();
      }
      return;
    }
    updateView((view) => {
      view.offsetX = dragState.originOffsetX + dx;
      view.offsetY = dragState.originOffsetY + dy;
    });
    renderPanFrame();
  });

  const finishPointer = (event) => {
    if (!dragState.active || dragState.pointerId !== event.pointerId) {
      return;
    }
    if (viewportElement.hasPointerCapture(event.pointerId)) {
      viewportElement.releasePointerCapture(event.pointerId);
    }
    viewportElement.classList.remove("is-panning");
    dragState.active = false;
    dragState.pointerId = null;
    dragState.suppressClick = dragState.moved;
    dragState.target = null;
    dragState.mode = null;
    setPreviewNavigating(false);
    if (dragState.moved || dragState.historyCaptured) {
      persistState();
    }
  };

  viewportElement.addEventListener("pointerup", finishPointer);
  viewportElement.addEventListener("pointercancel", finishPointer);
  viewportElement.addEventListener("click", (event) => {
    if (dragState.suppressClick) {
      dragState.suppressClick = false;
      return;
    }
    if (handleTargetClick(event)) {
      return;
    }
    placeFromClick(event);
  });
}

function createViewportDragState() {
  return {
    active: false,
    moved: false,
    suppressClick: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    originOffsetX: 0,
    originOffsetY: 0,
    mode: null,
    historyCaptured: false,
    target: null,
  };
}

function bindViewportWheelZoom({ viewportElement, ensureView, updateView, renderStage }) {
  viewportElement.addEventListener(
    "wheel",
    (event) => {
      const imageView = ensureView();
      if (!imageView) {
        return;
      }
      event.preventDefault();
      const pointer = getViewportPoint(event, viewportElement);
      const imageX = (pointer.x - imageView.offsetX) / imageView.scale;
      const imageY = (pointer.y - imageView.offsetY) / imageView.scale;
      const zoomFactor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = clamp(imageView.scale * zoomFactor, 0.15, 6);
      updateView((view) => {
        view.offsetX = pointer.x - imageX * nextScale;
        view.offsetY = pointer.y - imageY * nextScale;
        view.scale = nextScale;
      }, { persist: true });
      renderStage();
    },
    { passive: false }
  );
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

function placeTraceVertexFromPointerEvent(event, { store, renderer }) {
  if (!dom.traceImage.complete) {
    return;
  }
  const placement = renderer.resolveTracePlacement(
    getViewportPoint(event, dom.traceViewport),
    buildTracePlacementContext(store)
  );
  if (!placement) {
    return;
  }
  store.addTraceVertex(placement);
  renderer.renderAll();
}

function buildTracePlacementContext(store, { wayId = store.getSelectedTraceWay()?.id ?? null, vertexId = null } = {}) {
  return {
    sourceWayId: wayId,
    sourceVertexId: vertexId,
  };
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

async function copyTraceExport(renderer) {
  const exportText = dom.traceExportBox.textContent || "";
  if (!exportText.trim()) {
    renderer.setTraceStatus("No trace export is available to copy.");
    return;
  }
  try {
    await navigator.clipboard.writeText(exportText);
    renderer.setTraceStatus("Trace export copied to clipboard.");
  } catch (error) {
    console.error(error);
    renderer.setTraceStatus(`Copy failed: ${error.message || String(error)}`);
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

function getViewportPoint(event, viewportElement) {
  const rect = viewportElement.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function pointerEventToImagePoint(event, viewportElement, imageView) {
  if (!imageView) {
    return null;
  }
  const viewportPoint = getViewportPoint(event, viewportElement);
  return {
    x: (viewportPoint.x - imageView.offsetX) / imageView.scale,
    y: (viewportPoint.y - imageView.offsetY) / imageView.scale,
  };
}

function clampImagePointToFigure(imagePoint, figure) {
  if (!imagePoint || !figure) {
    return null;
  }
  if (imagePoint.x < 0 || imagePoint.y < 0 || imagePoint.x > figure.imageSize.width || imagePoint.y > figure.imageSize.height) {
    return null;
  }
  return {
    x: imagePoint.x,
    y: imagePoint.y,
  };
}

function getTraceTarget(target) {
  if (!(target instanceof Element)) {
    return null;
  }
  const vertexElement = target.closest("[data-trace-vertex-id]");
  if (vertexElement) {
    return {
      kind: "vertex",
      wayId: Number(vertexElement.getAttribute("data-trace-way-id")),
      vertexId: Number(vertexElement.getAttribute("data-trace-vertex-id")),
    };
  }
  const wayElement = target.closest("[data-trace-way-id]");
  if (wayElement) {
    return {
      kind: "way",
      wayId: Number(wayElement.getAttribute("data-trace-way-id")),
      vertexId: null,
    };
  }
  return null;
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
