const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
requireVersionedModuleContext(import.meta, "Route selection view module");

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

export function populateJunctionSelectors(startSelect, endSelect, area, scenario) {
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

  startSelect.value = scenario.start_junction_id;
  endSelect.value = scenario.end_junction_id;
}
