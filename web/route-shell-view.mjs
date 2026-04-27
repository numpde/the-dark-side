const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route shell view module");
const { clearErrorText, showErrorText } = await import(`./error-presentation.mjs${moduleSuffix}`);
const { installSelectionPlaceholders } = await import(`./route-selection-view.mjs${moduleSuffix}`);
const { setSummaryText } = await import(`./route-summary-view.mjs${moduleSuffix}`);

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

export function updateRouteSurfaceState(routeStrip, buttonRow, mapElement, invalidated) {
  routeStrip.classList.toggle("is-stale", invalidated);
  buttonRow.classList.toggle("is-stale", invalidated);
  mapElement.classList.toggle("is-stale", invalidated);
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
