export const DATASET_URL = "./generated/strava-fit-dataset.json";
export const STORAGE_KEY = "strava-fit-editor-v1";
export const MAX_MAP_ZOOM = 23;
export const MAP_WHEEL_ZOOM_SENSITIVITY = 0.01;
export const MAP_WHEEL_ZOOM_DELTA_LIMIT = 2;
export const MAX_UNDO_HISTORY = 100;
export const MAP_INTERACTION_CONFIG = {
  zoomSnap: 0,
  scrollWheelZoom: false,
};

export function createDefaultUiState() {
  return {
    figureId: null,
    fitMode: "axis-aligned",
    showRegion: true,
    showBounds: true,
  };
}

export function createDefaultFigureState() {
  return {
    nextPointNumber: 1,
    selectedPointId: null,
    points: [],
    lastFit: null,
  };
}

export const POINT_STATUS_META = {
  blank: {
    label: "blank",
    prompt: "Click the screenshot or map to start this point.",
  },
  imagePending: {
    label: "screenshot pending",
    prompt: "Click the screenshot to place this point.",
  },
  mapPending: {
    label: "map pending",
    prompt: "Click the map to finish this pair.",
  },
  paired: {
    label: "paired",
    prompt: "This point is paired. Reposition it or add a new point.",
  },
};
