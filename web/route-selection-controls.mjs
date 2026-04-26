function requireModuleVersion() {
  const version = new URL(import.meta.url).searchParams.get("v");
  if (!version) {
    throw new Error("Route selection controls module is missing required module version");
  }
  return version;
}

const MODULE_VERSION = requireModuleVersion();
const moduleSuffix = `?v=${encodeURIComponent(MODULE_VERSION)}`;
const {
  requireScenario,
  resolveCanonicalSelection,
  resolveScenarioSelection,
} = await import(`./route-scenarios.mjs${moduleSuffix}`);

export function installSelectionPlaceholders(areaSelect, startSelect, endSelect) {
  areaSelect.innerHTML = "<option>Loading…</option>";
  startSelect.innerHTML = "<option>Loading…</option>";
  endSelect.innerHTML = "<option>Loading…</option>";
}

export function populateAreaOptions(areaSelect, areas) {
  areaSelect.innerHTML = "";
  areas.forEach((area) => {
    const option = document.createElement("option");
    option.value = area.id;
    option.textContent = area.name;
    areaSelect.append(option);
  });
}

export function populateJunctionSelectors(startSelect, endSelect, area, requestedStart, requestedEnd) {
  startSelect.innerHTML = "";
  endSelect.innerHTML = "";
  area.junctions.forEach((junction) => {
    const startOption = document.createElement("option");
    startOption.value = junction.id;
    startOption.textContent = junction.name;
    startSelect.append(startOption);

    const endOption = document.createElement("option");
    endOption.value = junction.id;
    endOption.textContent = junction.name;
    endSelect.append(endOption);
  });

  const exactScenario = requireScenario(area, requestedStart, requestedEnd, "junction selector state");
  startSelect.value = exactScenario.start_junction_id;
  endSelect.value = exactScenario.end_junction_id;
}

export function syncSelectorsFromQuery(manifest, search, areaSelect, startSelect, endSelect) {
  const resolved = resolveCanonicalSelection(manifest, search);
  populateAreaOptions(areaSelect, manifest.areas);
  areaSelect.value = resolved.area.id;
  populateJunctionSelectors(
    startSelect,
    endSelect,
    resolved.area,
    resolved.scenario.start_junction_id,
    resolved.scenario.end_junction_id
  );
  return resolved;
}

export function canonicalizeSelectorScenario(startSelect, endSelect, area, preferredAnchor) {
  const resolved = resolveScenarioSelection(area, {
    startJunctionId: startSelect.value,
    endJunctionId: endSelect.value,
    preferredAnchor,
  });
  startSelect.value = resolved.scenario.start_junction_id;
  endSelect.value = resolved.scenario.end_junction_id;
  return resolved;
}

export function replaceUrlWithSelection(selection) {
  const query = new URLSearchParams(window.location.search);
  query.set("area", selection.areaId);
  query.set("start", selection.startJunctionId);
  query.set("end", selection.endJunctionId);
  window.history.replaceState({}, "", `${window.location.pathname}?${query.toString()}`);
}

export function syncUrlFromSelectors(areaSelect, startSelect, endSelect) {
  replaceUrlWithSelection({
    areaId: areaSelect.value,
    startJunctionId: startSelect.value,
    endJunctionId: endSelect.value,
  });
}
