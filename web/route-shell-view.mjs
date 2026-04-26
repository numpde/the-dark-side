function requireModuleVersion() {
  const version = new URL(import.meta.url).searchParams.get("v");
  if (!version) {
    throw new Error("Route shell view module is missing required module version");
  }
  return version;
}

const MODULE_VERSION = requireModuleVersion();
const moduleSuffix = `?v=${encodeURIComponent(MODULE_VERSION)}`;
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
  errorCard.textContent = message;
  errorCard.classList.remove("hidden");
}

export function clearError(errorCard) {
  errorCard.textContent = "";
  errorCard.classList.add("hidden");
}
