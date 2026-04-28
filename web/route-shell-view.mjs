import { clearErrorText, showErrorText } from "./error-presentation.mjs";
import { installSelectionPlaceholders } from "./route-selection-view.mjs";
import { setSummaryText } from "./route-summary-view.mjs";

export function setControlsDisabled(
  areaSelect,
  startSelect,
  endSelect,
  newRouteButton,
  { disabled, isLoading }
) {
  areaSelect.disabled = disabled;
  startSelect.disabled = disabled;
  endSelect.disabled = disabled;
  newRouteButton.disabled = disabled || isLoading;
}

export function updateDownloadLinkState(downloadLink, { enabled, href }) {
  downloadLink.classList.toggle("disabled", !enabled);
  if (!enabled || !href) {
    downloadLink.removeAttribute("href");
    return;
  }
  downloadLink.href = href;
}

export function updateRouteSurfaceState(routeStrip, buttonRow, mapElement, invalidated, loadingLabel = null) {
  routeStrip.classList.toggle("is-stale", invalidated);
  buttonRow.classList.toggle("is-stale", invalidated);
  mapElement.classList.toggle("is-stale", invalidated);
  if (invalidated && loadingLabel) {
    mapElement.dataset.loadingLabel = loadingLabel;
    return;
  }
  delete mapElement.dataset.loadingLabel;
}

export function installShellPlaceholders(
  scenarioLabel,
  areaSelect,
  startSelect,
  endSelect
) {
  setSummaryText(scenarioLabel, "Loading routes…");
  installSelectionPlaceholders(areaSelect, startSelect, endSelect);
}

export function showError(errorCard, message) {
  showErrorText(errorCard, message);
}

export function clearError(errorCard) {
  clearErrorText(errorCard);
}
