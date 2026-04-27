const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
requireVersionedModuleContext(import.meta, "Route URL state module");

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
