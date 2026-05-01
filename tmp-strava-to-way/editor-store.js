import {
  MAX_UNDO_HISTORY,
  STORAGE_KEY,
  POINT_STATUS_META,
  createDefaultFigureState,
  createDefaultFigureViews,
  createDefaultTraceState,
  createDefaultTraceWayTags,
  createDefaultUiState,
  TRACE_WAY_TAG_PRESETS,
} from "./editor-config.js?v=20260427aw";
import { getFitModeConfig, resolveTraceVertexPlacement } from "./editor-fit.js?v=20260427aw";

export function createEditorStore(dataset) {
  const state = loadState();
  const figureHistory = new Map();

  if (!state.ui.figureId || !getFigureById(state.ui.figureId)) {
    state.ui.figureId = dataset.figures[0]?.id ?? null;
  }
  state.ui.fitMode = getFitModeConfig(state.ui.fitMode).key;

  function getUiState() {
    return state.ui;
  }

  function getFigureById(figureId) {
    return dataset.figures.find((figure) => figure.id === figureId) ?? null;
  }

  function getCurrentFigure() {
    return getFigureById(state.ui.figureId);
  }

  function ensureFigureState(figureId = state.ui.figureId) {
    if (!state.figures[figureId]) {
      state.figures[figureId] = createDefaultFigureState();
    } else {
      state.figures[figureId] = normalizeFigureState(state.figures[figureId]);
    }
    return state.figures[figureId];
  }

  function getCurrentFigureState() {
    return ensureFigureState();
  }

  function getCurrentFit() {
    return getCurrentFigureState().lastFit;
  }

  function canUndoCurrentFigure() {
    return getFigureHistory().length > 0;
  }

  function mutateUiState(mutator) {
    const result = mutator(state.ui);
    persistState();
    return result;
  }

  function mutateCurrentFigureState(mutator, { invalidate = false, history = false, persist = true } = {}) {
    const figureId = state.ui.figureId;
    const figureState = getCurrentFigureState();
    const previousUndoState = history ? snapshotUndoState(figureState) : null;
    const result = mutator(figureState);
    if (invalidate) {
      figureState.lastFit = null;
    }
    if (history) {
      const nextUndoState = snapshotUndoState(figureState);
      if (serializeUndoState(previousUndoState) !== serializeUndoState(nextUndoState)) {
        rememberFigureUndoState(figureId, previousUndoState);
      }
    }
    if (persist) {
      persistState();
    }
    return result;
  }

  function mutateUndoableFigureState(mutator, { invalidate = false, persist = true } = {}) {
    return mutateCurrentFigureState(mutator, { invalidate, history: true, persist });
  }

  function setFigureId(figureId) {
    mutateUiState((ui) => {
      ui.figureId = figureId;
    });
  }

  function setFitMode(fitModeKey) {
    mutateUiState((ui) => {
      ui.fitMode = getFitModeConfig(fitModeKey).key;
    });
  }

  function setShowRegion(visible) {
    mutateUiState((ui) => {
      ui.showRegion = visible;
    });
  }

  function setShowBounds(visible) {
    mutateUiState((ui) => {
      ui.showBounds = visible;
    });
  }

  function getFitMode() {
    return getFitModeConfig(state.ui.fitMode);
  }

  function createPoint(figureState) {
    const pointId = figureState.nextPointNumber;
    figureState.nextPointNumber += 1;
    const point = { id: pointId, image: null, map: null };
    figureState.points.push(point);
    return point;
  }

  function getSelectedPoint(figureState = getCurrentFigureState()) {
    return figureState.points.find((point) => point.id === figureState.selectedPointId) ?? null;
  }

  function getPlacementPointId(figureState = getCurrentFigureState()) {
    return getSelectedPoint(figureState)?.id ?? figureState.nextPointNumber;
  }

  function ensureSelectedPointRecord(figureState = getCurrentFigureState()) {
    const selectedPoint = getSelectedPoint(figureState);
    if (selectedPoint) {
      return selectedPoint;
    }
    const point = createPoint(figureState);
    figureState.selectedPointId = point.id;
    return point;
  }

  function addPoint() {
    return mutateUndoableFigureState((figureState) => {
      const point = createPoint(figureState);
      figureState.selectedPointId = point.id;
      return point;
    }, { invalidate: true });
  }

  function selectPoint(pointId) {
    mutateCurrentFigureState((figureState) => {
      figureState.selectedPointId = pointId;
    });
  }

  function deleteSelectedPoint() {
    const selectedPoint = getSelectedPoint();
    if (!selectedPoint) {
      return;
    }
    mutateUndoableFigureState((figureState) => {
      figureState.points = figureState.points.filter((point) => point.id !== selectedPoint.id);
      figureState.selectedPointId = figureState.points.at(-1)?.id ?? null;
    }, { invalidate: true });
  }

  function clearCurrentFigurePoints() {
    mutateUndoableFigureState((figureState) => {
      figureState.nextPointNumber = 1;
      figureState.selectedPointId = null;
      figureState.points = [];
      figureState.lastFit = null;
    });
  }

  function assignSelectedPointImage(imageX, imageY) {
    mutateUndoableFigureState((figureState) => {
      const point = ensureSelectedPointRecord(figureState);
      point.image = {
        x: roundTo(imageX, 2),
        y: roundTo(imageY, 2),
      };
      figureState.selectedPointId = point.id;
    }, { invalidate: true });
  }

  function assignSelectedPointMap(latlng) {
    mutateUndoableFigureState((figureState) => {
      const point = ensureSelectedPointRecord(figureState);
      assignPointMapRecord(point, latlng, figureState);
    }, { invalidate: true });
  }

  function assignPointMap(pointId, latlng) {
    mutateUndoableFigureState((figureState) => {
      const point = getPointById(pointId, figureState);
      if (!point) {
        return;
      }
      assignPointMapRecord(point, latlng, figureState);
    }, { invalidate: true });
  }

  function setCurrentFit(fitResult) {
    mutateUndoableFigureState((figureState) => {
      figureState.lastFit = fitResult;
    });
  }

  function undoCurrentFigureState() {
    const undoState = getFigureHistory().pop();
    if (!undoState) {
      return false;
    }
    restoreUndoState(getCurrentFigureState(), undoState);
    persistState();
    return true;
  }

  function getPointStatus(point) {
    if (point.image && point.map) {
      return "paired";
    }
    if (point.image) {
      return "mapPending";
    }
    if (point.map) {
      return "imagePending";
    }
    return "blank";
  }

  function describePoint(point) {
    const statusKey = getPointStatus(point);
    return {
      statusKey,
      statusLabel: POINT_STATUS_META[statusKey].label,
      prompt: POINT_STATUS_META[statusKey].prompt,
      imageStateLabel: point.image ? "screenshot set" : "screenshot pending",
      mapStateLabel: point.map ? "map set" : "map pending",
      imageCoordinateLabel: point.image
        ? `img: ${point.image.x.toFixed(2)}, ${point.image.y.toFixed(2)} px`
        : "img: pending",
      mapCoordinateLabel: point.map
        ? `map: ${point.map.lat.toFixed(7)}, ${point.map.lon.toFixed(7)}`
        : "map: pending",
    };
  }

  function getPairedPoints(figureState = getCurrentFigureState()) {
    return figureState.points.filter((point) => point.image && point.map);
  }

  function getPairedPointCount(figureState = getCurrentFigureState()) {
    return getPairedPoints(figureState).length;
  }

  function formatCount(count, noun) {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  function getCurrentTrace() {
    return getCurrentFigureState().trace;
  }

  function getSelectedTraceWay(traceState = getCurrentTrace()) {
    return traceState.ways.find((way) => way.id === traceState.selectedWayId) ?? null;
  }

  function getSelectedTraceVertex(traceState = getCurrentTrace()) {
    const selectedWay = getSelectedTraceWay(traceState);
    return selectedWay?.vertices.find((vertex) => vertex.id === traceState.selectedVertexId) ?? null;
  }

  function addTraceWay() {
    return mutateUndoableFigureState((figureState) => {
      const way = createTraceWay(figureState.trace);
      figureState.trace.ways.push(way);
      figureState.trace.selectedWayId = way.id;
      figureState.trace.selectedVertexId = null;
      return way;
    });
  }

  function updateSelectedTraceWayTags(tagPatch) {
    mutateUndoableFigureState((figureState) => {
      const selectedWay = getSelectedTraceWay(figureState.trace);
      if (!selectedWay) {
        return;
      }
      selectedWay.tags = {
        ...normalizeTraceWayTags(selectedWay.tags),
        ...tagPatch,
      };
    });
  }

  function applySelectedTraceWayPreset(presetKey) {
    const preset = TRACE_WAY_TAG_PRESETS[presetKey];
    if (!preset) {
      return;
    }
    updateSelectedTraceWayTags(preset);
  }

  function selectTraceWay(wayId) {
    mutateCurrentFigureState((figureState) => {
      const traceState = figureState.trace;
      const way = getTraceWayById(wayId, traceState);
      traceState.selectedWayId = way?.id ?? null;
      traceState.selectedVertexId = way?.vertices.at(-1)?.id ?? null;
    });
  }

  function selectTraceVertex(wayId, vertexId) {
    mutateCurrentFigureState((figureState) => {
      const traceState = figureState.trace;
      const way = getTraceWayById(wayId, traceState);
      const vertex = way?.vertices.find((item) => item.id === vertexId) ?? null;
      traceState.selectedWayId = way?.id ?? null;
      traceState.selectedVertexId = vertex?.id ?? null;
    });
  }

  function addTraceVertex(placement) {
    return mutateUndoableFigureState((figureState) => {
      const traceState = figureState.trace;
      const way = ensureSelectedTraceWay(traceState);
      const vertex = createTraceVertex(traceState, placement);
      way.vertices.push(vertex);
      traceState.selectedWayId = way.id;
      traceState.selectedVertexId = vertex.id;
      return vertex;
    });
  }

  function assignTraceVertex(wayId, vertexId, placement, { history = false, persist = true } = {}) {
    const mutate = history ? mutateUndoableFigureState : mutateCurrentFigureState;
    return mutate((figureState) => {
      const traceState = figureState.trace;
      const way = getTraceWayById(wayId, traceState);
      const vertex = getTraceVertexById(way, vertexId);
      if (!vertex) {
        return null;
      }
      applyTraceVertexPlacement(vertex, placement);
      traceState.selectedWayId = way.id;
      traceState.selectedVertexId = vertex.id;
      return vertex;
    }, { persist });
  }

  function deleteSelectedTraceVertex() {
    const traceState = getCurrentTrace();
    const selectedWay = getSelectedTraceWay(traceState);
    const selectedVertex = getSelectedTraceVertex(traceState);
    if (!selectedWay || !selectedVertex) {
      return;
    }
    mutateUndoableFigureState((figureState) => {
      const currentTrace = figureState.trace;
      const way = getTraceWayById(selectedWay.id, currentTrace);
      if (!way) {
        return;
      }
      freezeAndClearTraceVertexReferences(
        currentTrace,
        (vertex) => vertex.traceVertexSnap?.wayId === way.id && vertex.traceVertexSnap?.vertexId === selectedVertex.id
      );
      way.vertices = way.vertices.filter((vertex) => vertex.id !== selectedVertex.id);
      if (!way.vertices.length) {
        currentTrace.ways = currentTrace.ways.filter((item) => item.id !== way.id);
        const fallbackWay = currentTrace.ways.at(-1) ?? null;
        currentTrace.selectedWayId = fallbackWay?.id ?? null;
        currentTrace.selectedVertexId = fallbackWay?.vertices.at(-1)?.id ?? null;
        return;
      }
      currentTrace.selectedWayId = way.id;
      currentTrace.selectedVertexId = way.vertices.at(-1)?.id ?? null;
    });
  }

  function deleteSelectedTraceWay() {
    const traceState = getCurrentTrace();
    const selectedWay = getSelectedTraceWay(traceState);
    if (!selectedWay) {
      return;
    }
    mutateUndoableFigureState((figureState) => {
      const currentTrace = figureState.trace;
      freezeAndClearTraceVertexReferences(
        currentTrace,
        (vertex) => vertex.traceVertexSnap?.wayId === selectedWay.id
      );
      currentTrace.ways = currentTrace.ways.filter((way) => way.id !== selectedWay.id);
      const fallbackWay = currentTrace.ways.at(-1) ?? null;
      currentTrace.selectedWayId = fallbackWay?.id ?? null;
      currentTrace.selectedVertexId = fallbackWay?.vertices.at(-1)?.id ?? null;
    });
  }

  function getCurrentImageView() {
    return getCurrentViewportView("control");
  }

  function getCurrentTraceView() {
    return getCurrentViewportView("trace");
  }

  function getCurrentViewportView(viewKey) {
    return getCurrentFigureState().views[viewKey] ?? null;
  }

  function ensureImageViewForCurrentFigure(viewportElement, options = {}) {
    return ensureViewportViewForCurrentFigure("control", viewportElement, options);
  }

  function ensureTraceViewForCurrentFigure(viewportElement, options = {}) {
    return ensureViewportViewForCurrentFigure("trace", viewportElement, options);
  }

  function ensureViewportViewForCurrentFigure(viewKey, viewportElement, { forceReset = false, persist = false } = {}) {
    const figure = getCurrentFigure();
    const figureState = getCurrentFigureState();
    if (!figure) {
      return null;
    }
    if (figureState.views[viewKey] && !forceReset) {
      return figureState.views[viewKey];
    }
    const viewportWidth = Math.max(viewportElement.clientWidth, 1);
    const viewportHeight = Math.max(viewportElement.clientHeight, 1);
    const fitScale = Math.min(viewportWidth / figure.imageSize.width, viewportHeight / figure.imageSize.height) * 0.96;
    figureState.views[viewKey] = {
      scale: roundTo(clamp(fitScale, 0.15, 6), 4),
      offsetX: roundTo((viewportWidth - figure.imageSize.width * fitScale) / 2, 2),
      offsetY: roundTo((viewportHeight - figure.imageSize.height * fitScale) / 2, 2),
    };
    if (persist) {
      persistState();
    }
    return figureState.views[viewKey];
  }

  function updateCurrentImageView(mutator, options = {}) {
    return updateCurrentViewportView("control", mutator, options);
  }

  function updateCurrentTraceView(mutator, options = {}) {
    return updateCurrentViewportView("trace", mutator, options);
  }

  function updateCurrentViewportView(viewKey, mutator, { persist = false } = {}) {
    const view = getCurrentViewportView(viewKey);
    if (!view) {
      return null;
    }
    const result = mutator(view);
    if (persist) {
      persistState();
    }
    return result;
  }

  function persistState() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function getFigureHistory(figureId = state.ui.figureId) {
    if (!figureHistory.has(figureId)) {
      figureHistory.set(figureId, []);
    }
    return figureHistory.get(figureId);
  }

  function rememberFigureUndoState(figureId, undoState) {
    const history = getFigureHistory(figureId);
    history.push(cloneValue(undoState));
    if (history.length > MAX_UNDO_HISTORY) {
      history.splice(0, history.length - MAX_UNDO_HISTORY);
    }
  }

  function loadState() {
    const fallback = {
      ui: createDefaultUiState(),
      figures: {},
    };
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return fallback;
      }
      const parsed = JSON.parse(raw);
      return {
        ui: { ...createDefaultUiState(), ...(parsed.ui || {}) },
        figures: Object.fromEntries(
          Object.entries(parsed.figures || {}).map(([figureId, figureState]) => [figureId, normalizeFigureState(figureState)])
        ),
      };
    } catch (error) {
      console.warn("Failed to load editor state", error);
      return fallback;
    }
  }

  return {
    getUiState,
    getFigureById,
    getCurrentFigure,
    getCurrentFigureState,
    getCurrentFit,
    canUndoCurrentFigure,
    setFigureId,
    setFitMode,
    setShowRegion,
    setShowBounds,
    getFitMode,
    addPoint,
    getSelectedPoint,
    getPlacementPointId,
    selectPoint,
    deleteSelectedPoint,
    clearCurrentFigurePoints,
    assignSelectedPointImage,
    assignSelectedPointMap,
    assignPointMap,
    setCurrentFit,
    undoCurrentFigureState,
    describePoint,
    getPairedPoints,
    getPairedPointCount,
    formatCount,
    getCurrentTrace,
    getSelectedTraceWay,
    getSelectedTraceVertex,
    addTraceWay,
    updateSelectedTraceWayTags,
    applySelectedTraceWayPreset,
    selectTraceWay,
    selectTraceVertex,
    addTraceVertex,
    assignTraceVertex,
    deleteSelectedTraceVertex,
    deleteSelectedTraceWay,
    getCurrentImageView,
    getCurrentTraceView,
    ensureImageViewForCurrentFigure,
    ensureTraceViewForCurrentFigure,
    updateCurrentImageView,
    updateCurrentTraceView,
    persistState,
  };
}

function normalizeFigureState(figureState) {
  const views = normalizeFigureViews(figureState);
  const trace = normalizeTraceState(figureState?.trace);
  return {
    ...createDefaultFigureState(),
    ...figureState,
    points: Array.isArray(figureState?.points) ? figureState.points : [],
    lastFit: normalizeFitRecord(figureState?.lastFit),
    views,
    trace,
  };
}

function snapshotUndoState(figureState) {
  return cloneValue({
    nextPointNumber: figureState.nextPointNumber,
    selectedPointId: figureState.selectedPointId,
    points: figureState.points,
    lastFit: figureState.lastFit,
    trace: figureState.trace,
  });
}

function restoreUndoState(figureState, undoState) {
  figureState.nextPointNumber = undoState.nextPointNumber;
  figureState.selectedPointId = undoState.selectedPointId;
  figureState.points = cloneValue(undoState.points);
  figureState.lastFit = cloneValue(undoState.lastFit);
  figureState.trace = normalizeTraceState(cloneValue(undoState.trace));
}

function serializeUndoState(undoState) {
  return JSON.stringify(undoState);
}

function cloneValue(value) {
  return value == null ? value : structuredClone(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getPointById(pointId, figureState) {
  return figureState.points.find((point) => point.id === pointId) ?? null;
}

function assignPointMapRecord(point, latlng, figureState) {
  point.map = {
    lat: roundTo(latlng.lat, 7),
    lon: roundTo(latlng.lon ?? latlng.lng, 7),
  };
  figureState.selectedPointId = point.id;
}

function normalizeFigureViews(figureState) {
  const legacyControlView = figureState?.imageView ?? null;
  const legacyTraceView = figureState?.traceView ?? null;
  return {
    ...createDefaultFigureViews(),
    ...(figureState?.views || {}),
    control: figureState?.views?.control ?? legacyControlView,
    trace: figureState?.views?.trace ?? legacyTraceView,
  };
}

function normalizeTraceState(traceState) {
  return {
    ...createDefaultTraceState(),
    ...(traceState || {}),
    ways: Array.isArray(traceState?.ways)
      ? traceState.ways.map((way) => ({
          id: way.id,
          tags: normalizeTraceWayTags(way.tags),
          vertices: Array.isArray(way.vertices) ? way.vertices.map(normalizeTraceVertex) : [],
        }))
      : [],
  };
}

function createTraceWay(traceState) {
  const way = {
    id: traceState.nextWayNumber,
    tags: createDefaultTraceWayTags(),
    vertices: [],
  };
  traceState.nextWayNumber += 1;
  return way;
}

function ensureSelectedTraceWay(traceState) {
  const selectedWay = getTraceWayById(traceState.selectedWayId, traceState);
  if (selectedWay) {
    return selectedWay;
  }
  const way = createTraceWay(traceState);
  traceState.ways.push(way);
  traceState.selectedWayId = way.id;
  traceState.selectedVertexId = null;
  return way;
}

function createTraceVertex(traceState, placement) {
  const vertex = { id: traceState.nextVertexNumber };
  applyTraceVertexPlacement(vertex, placement);
  traceState.nextVertexNumber += 1;
  return vertex;
}

function normalizeTraceVertex(vertex) {
  return {
    id: vertex.id,
    x: roundTo(vertex.x, 2),
    y: roundTo(vertex.y, 2),
    osmNodeId: vertex.osmNodeId ?? null,
    osmLat: vertex.osmLat != null ? roundTo(vertex.osmLat, 7) : null,
    osmLon: vertex.osmLon != null ? roundTo(vertex.osmLon, 7) : null,
    segmentSnap: normalizeSegmentSnap(vertex.segmentSnap),
    traceVertexSnap: normalizeTraceVertexSnap(vertex.traceVertexSnap),
  };
}

function normalizeTraceWayTags(tags) {
  return {
    ...createDefaultTraceWayTags(),
    ...(tags || {}),
  };
}

function applyTraceVertexPlacement(vertex, placement) {
  vertex.x = roundTo(placement.x, 2);
  vertex.y = roundTo(placement.y, 2);
  vertex.osmNodeId = placement.osmNodeId ?? null;
  vertex.osmLat = placement.osmLat != null ? roundTo(placement.osmLat, 7) : null;
  vertex.osmLon = placement.osmLon != null ? roundTo(placement.osmLon, 7) : null;
  vertex.segmentSnap = normalizeSegmentSnap(placement.segmentSnap);
  vertex.traceVertexSnap = normalizeTraceVertexSnap(placement.traceVertexSnap);
}

function freezeAndClearTraceVertexReferences(traceState, shouldClear) {
  for (const way of traceState.ways) {
    for (const vertex of way.vertices) {
      if (!shouldClear(vertex)) {
        continue;
      }
      const resolvedPlacement = resolveTraceVertexPlacement(traceState, way.id, vertex.id);
      applyTraceVertexPlacement(vertex, {
        x: resolvedPlacement?.x ?? vertex.x,
        y: resolvedPlacement?.y ?? vertex.y,
        osmNodeId: resolvedPlacement?.osmNodeId ?? vertex.osmNodeId,
        osmLat: resolvedPlacement?.osmLat ?? vertex.osmLat,
        osmLon: resolvedPlacement?.osmLon ?? vertex.osmLon,
        segmentSnap: resolvedPlacement?.segmentSnap ?? vertex.segmentSnap,
        traceVertexSnap: null,
      });
    }
  }
}

function normalizeSegmentSnap(segmentSnap) {
  if (!segmentSnap) {
    return null;
  }
  return {
    wayId: segmentSnap.wayId,
    wayVersion: segmentSnap.wayVersion ?? null,
    segmentIndex: segmentSnap.segmentIndex,
    startNodeId: segmentSnap.startNodeId,
    endNodeId: segmentSnap.endNodeId,
    t: roundTo(segmentSnap.t, 6),
  };
}

function normalizeTraceVertexSnap(traceVertexSnap) {
  if (!traceVertexSnap) {
    return null;
  }
  return {
    wayId: traceVertexSnap.wayId,
    vertexId: traceVertexSnap.vertexId,
  };
}

function normalizeFitRecord(lastFit) {
  if (!lastFit) {
    return null;
  }
  if (lastFit.output) {
    return lastFit;
  }
  const corners = Array.isArray(lastFit.corners) ? lastFit.corners : [];
  return {
    fitModel: null,
    polygonLatLngs: corners.map((corner) => [corner.lat, corner.lon]),
    output: lastFit,
  };
}

function getTraceWayById(wayId, traceState) {
  return traceState.ways.find((way) => way.id === wayId) ?? null;
}

function getTraceVertexById(way, vertexId) {
  return way?.vertices.find((vertex) => vertex.id === vertexId) ?? null;
}
