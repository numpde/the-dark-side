const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route shell view module");
const { clearErrorText, showErrorText } = await import(`./error-presentation.mjs${moduleSuffix}`);
const { installSelectionPlaceholders } = await import(`./route-selection-controls.mjs${moduleSuffix}`);
const { setSummaryText } = await import(`./route-summary-view.mjs${moduleSuffix}`);

export function setControlsDisabled(
  areaSelect,
  startSelect,
  endSelect,
  newRouteButton,
  downloadLink,
  { disabled, isLoading, hasRoute }
) {
  areaSelect.disabled = disabled;
  startSelect.disabled = disabled;
  endSelect.disabled = disabled;
  newRouteButton.disabled = disabled || isLoading;
  downloadLink.classList.toggle("disabled", disabled || isLoading || !hasRoute);
  if (disabled || isLoading || !hasRoute) {
    downloadLink.removeAttribute("href");
  }
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
