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
export const TRACE_WAY_SOURCE = "Strava Global Heatmap";
export const TRACE_WAY_TAG_PRESETS = {
  custom: null,
  blank: {
    highway: "",
    foot: "",
    bicycle: "",
    mtbScale: "",
  },
  footMtbPath: {
    highway: "path",
    foot: "yes",
    bicycle: "yes",
    mtbScale: "2+",
  },
  footPath: {
    highway: "path",
    foot: "yes",
    bicycle: "",
    mtbScale: "",
  },
  cyclePath: {
    highway: "path",
    foot: "",
    bicycle: "yes",
    mtbScale: "",
  },
};
export const TRACE_WAY_TAG_FIELDS = [
  {
    key: "highway",
    label: "Highway",
    options: [
      { value: "", label: "Unset" },
      { value: "path", label: "path" },
      { value: "track", label: "track" },
      { value: "footway", label: "footway" },
      { value: "cycleway", label: "cycleway" },
      { value: "bridleway", label: "bridleway" },
    ],
  },
  {
    key: "foot",
    label: "Foot",
    options: [
      { value: "", label: "Unset" },
      { value: "yes", label: "yes" },
      { value: "designated", label: "designated" },
      { value: "permissive", label: "permissive" },
      { value: "no", label: "no" },
    ],
  },
  {
    key: "bicycle",
    label: "Bicycle",
    options: [
      { value: "", label: "Unset" },
      { value: "yes", label: "yes" },
      { value: "designated", label: "designated" },
      { value: "permissive", label: "permissive" },
      { value: "no", label: "no" },
    ],
  },
  {
    key: "mtbScale",
    label: "MTB Scale",
    options: [
      { value: "", label: "Unset" },
      { value: "0", label: "0" },
      { value: "0+", label: "0+" },
      { value: "1", label: "1" },
      { value: "1+", label: "1+" },
      { value: "2", label: "2" },
      { value: "2+", label: "2+" },
      { value: "3", label: "3" },
      { value: "3+", label: "3+" },
      { value: "4", label: "4" },
    ],
  },
];

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
    views: createDefaultFigureViews(),
    trace: createDefaultTraceState(),
  };
}

export function createDefaultFigureViews() {
  return {
    control: null,
    trace: null,
  };
}

export function createDefaultTraceState() {
  return {
    nextWayNumber: 1,
    nextVertexNumber: 1,
    selectedWayId: null,
    selectedVertexId: null,
    ways: [],
  };
}

export function createDefaultTraceWayTags() {
  return {
    highway: "",
    foot: "",
    bicycle: "",
    mtbScale: "",
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
