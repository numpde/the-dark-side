import {
  MAX_UNDO_HISTORY,
  STORAGE_KEY,
  POINT_STATUS_META,
  createDefaultFigureState,
  createDefaultUiState,
} from "./editor-config.js?v=20260427ac";
import { getFitModeConfig } from "./editor-fit.js?v=20260427ac";

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

  function mutateCurrentFigureState(mutator, { invalidate = false, history = false } = {}) {
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
    persistState();
    return result;
  }

  function mutateUndoableFigureState(mutator, { invalidate = false } = {}) {
    return mutateCurrentFigureState(mutator, { invalidate, history: true });
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
      Object.assign(figureState, createDefaultFigureState());
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

  function getCurrentImageView() {
    return getCurrentFigureState().imageView ?? null;
  }

  function ensureImageViewForCurrentFigure(viewportElement, { forceReset = false, persist = false } = {}) {
    const figure = getCurrentFigure();
    const figureState = getCurrentFigureState();
    if (!figure) {
      return null;
    }
    if (figureState.imageView && !forceReset) {
      return figureState.imageView;
    }
    const viewportWidth = Math.max(viewportElement.clientWidth, 1);
    const viewportHeight = Math.max(viewportElement.clientHeight, 1);
    const fitScale = Math.min(viewportWidth / figure.imageSize.width, viewportHeight / figure.imageSize.height) * 0.96;
    figureState.imageView = {
      scale: roundTo(clamp(fitScale, 0.15, 6), 4),
      offsetX: roundTo((viewportWidth - figure.imageSize.width * fitScale) / 2, 2),
      offsetY: roundTo((viewportHeight - figure.imageSize.height * fitScale) / 2, 2),
    };
    if (persist) {
      persistState();
    }
    return figureState.imageView;
  }

  function updateCurrentImageView(mutator, { persist = false } = {}) {
    const imageView = getCurrentImageView();
    if (!imageView) {
      return null;
    }
    const result = mutator(imageView);
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
    getCurrentImageView,
    ensureImageViewForCurrentFigure,
    updateCurrentImageView,
    persistState,
  };
}

function normalizeFigureState(figureState) {
  return {
    ...createDefaultFigureState(),
    ...figureState,
    points: Array.isArray(figureState?.points) ? figureState.points : [],
  };
}

function snapshotUndoState(figureState) {
  return cloneValue({
    nextPointNumber: figureState.nextPointNumber,
    selectedPointId: figureState.selectedPointId,
    points: figureState.points,
    lastFit: figureState.lastFit,
  });
}

function restoreUndoState(figureState, undoState) {
  figureState.nextPointNumber = undoState.nextPointNumber;
  figureState.selectedPointId = undoState.selectedPointId;
  figureState.points = cloneValue(undoState.points);
  figureState.lastFit = cloneValue(undoState.lastFit);
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
