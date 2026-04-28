import {
  buildRoutePolicyDocument,
  countRoutePolicyChanges,
  explicitPolicyForContig,
  defaultWayPolicy,
  emptyRoutePolicyDocument,
  normalizeRoutePolicyDocument,
  policyForContig,
  setContigPolicy,
} from "./editor-state.mjs";
import {
  karuraTodayString,
  isCurrentlyUnavailable as isPolicyCurrentlyUnavailable,
} from "./karura-policy.mjs";
import {
  downloadJsonDocument,
  loadEditorBundle,
  readJsonFile,
} from "./editor-asset-runtime.mjs";
import { createEditorMapView, styleForPolicy } from "./editor-map-view.mjs";
import { createEditorShellView } from "./editor-shell-view.mjs";
import { validateEditorManifest } from "./runtime-contracts.mjs";

function isCurrentlyUnavailable(policy) {
  return isPolicyCurrentlyUnavailable(
    { "local:unavailable_until": policy.unavailableUntil ?? undefined },
    karuraTodayString(),
  );
}

function isDefaultPolicy(policy) {
  return (
    policy.routingState === "default" &&
    policy.bikeability == null &&
    policy.bicycleDirection === "both" &&
    policy.unavailableUntil == null
  );
}

export function createEditorController({ editorManifestUrl, reportError }) {
  const appState = {
    selectedContigId: null,
    editorState: normalizeRoutePolicyDocument(emptyRoutePolicyDocument()),
    loadedRoutePolicyLabel: "–",
    editorManifest: null,
    assetUrls: null,
  };

  function canonicalRoutePolicyPath() {
    return appState.assetUrls.routePolicyPath;
  }

  const mapView = createEditorMapView({
    mapElementId: "map",
    onSelectContig: (contigId) => selectContig(contigId),
    resolveFeatureStyle: (feature) => styleForPolicy(
      policyForContig(appState.editorState, feature.properties.contig_id),
      feature,
      isCurrentlyUnavailable,
    ),
  });

  const shellView = createEditorShellView({
    reportError,
    onRoutingStateChange: (routingState) => updateSelectedPolicy({ routingState }),
    onBikeabilityChange: (bikeability) => updateSelectedPolicy({ bikeability }),
    onDirectionChange: (bicycleDirection) => updateSelectedPolicy({ bicycleDirection }),
    onUnavailableUntilChange: (unavailableUntil) => updateSelectedPolicy({ unavailableUntil }),
    onClear: () => {
      if (appState.selectedContigId == null) {
        return;
      }
      setContigPolicy(appState.editorState, appState.selectedContigId, defaultWayPolicy());
      mapView.updateContigStyle(appState.selectedContigId);
      shellView.clearError();
      renderShell();
    },
    onExport: () => exportRoutePolicy(),
    onImportFile: async (file) => {
      await importRoutePolicy(file);
      shellView.clearError();
    },
  });

  function currentRoutePolicyDocument() {
    return buildRoutePolicyDocument(appState.editorState, mapView.getContigFeatures());
  }

  function renderShell() {
    const feature = mapView.featureForContig(appState.selectedContigId);
    const policy = feature
      ? policyForContig(appState.editorState, appState.selectedContigId)
      : defaultWayPolicy();
    const explicitPolicy = feature
      ? explicitPolicyForContig(appState.editorState, appState.selectedContigId)
      : defaultWayPolicy();

    shellView.update({
      feature,
      policy,
      loadedRoutePolicyLabel: appState.loadedRoutePolicyLabel,
      canonicalRoutePolicyPath: canonicalRoutePolicyPath(),
      editorGraphAssetId: appState.editorManifest.meta.editor_graph_asset_id,
      editorGeneratedAtText: appState.editorManifest.meta.generated_at,
      changedCount: countRoutePolicyChanges(appState.editorState, mapView.getContigFeatures()),
      routePolicyDocument: currentRoutePolicyDocument(),
      clearDisabled: !feature || isDefaultPolicy(explicitPolicy),
    });
    mapView.renderSelectedContig(appState.selectedContigId);
  }

  function selectContig(contigId) {
    appState.selectedContigId = Number(contigId);
    shellView.clearError();
    renderShell();
  }

  function updateSelectedPolicy(partial) {
    if (appState.selectedContigId == null) {
      return;
    }
    const current = policyForContig(appState.editorState, appState.selectedContigId);
    setContigPolicy(appState.editorState, appState.selectedContigId, { ...current, ...partial });
    mapView.updateContigStyle(appState.selectedContigId);
    renderShell();
  }

  function exportRoutePolicy() {
    downloadJsonDocument(currentRoutePolicyDocument(), appState.assetUrls.routePolicyFilename);
  }

  async function importRoutePolicy(file) {
    appState.editorState = normalizeRoutePolicyDocument(await readJsonFile(file), mapView.getContigFeatures());
    appState.loadedRoutePolicyLabel = `imported/${file.name}`;
    mapView.updateAllContigStyles();
    renderShell();
  }

  async function boot() {
    const { editorManifest, assetUrls, waysGeojson, routePolicy } = await loadEditorBundle({
      editorManifestUrl,
      validateEditorManifest,
      pageUrl: window.location.href,
    });
    appState.editorManifest = editorManifest;
    appState.assetUrls = assetUrls;
    mapView.renderWays(waysGeojson);
    appState.editorState = normalizeRoutePolicyDocument(routePolicy, mapView.getContigFeatures());
    appState.loadedRoutePolicyLabel = canonicalRoutePolicyPath();
    mapView.updateAllContigStyles();
    renderShell();
  }

  return {
    boot,
  };
}
