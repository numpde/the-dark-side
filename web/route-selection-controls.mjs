const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route selection controls module");
const {
  resolveCanonicalSelection,
  resolveScenarioSelection,
} = await import(`./route-scenarios.mjs${moduleSuffix}`);
const {
  populateAreaOptions,
  populateJunctionSelectors,
} = await import(`./route-selection-view.mjs${moduleSuffix}`);

export function syncSelectorsFromQuery(manifest, search, areaSelect, startSelect, endSelect) {
  const resolved = resolveCanonicalSelection(manifest, search);
  populateAreaOptions(areaSelect, manifest.areas);
  areaSelect.value = resolved.area.id;
  populateJunctionSelectors(
    startSelect,
    endSelect,
    resolved.area,
    resolved.scenario,
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
