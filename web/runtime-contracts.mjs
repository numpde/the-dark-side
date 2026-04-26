import {
  requireArray,
  requireFiniteNumber,
  requireInteger,
  requireObject,
  requireString,
} from "./contract-primitives.mjs";

export {
  requireArray,
  requireFiniteNumber,
  requireInteger,
  requireObject,
  requireString,
} from "./contract-primitives.mjs";

function validateJunction(junction, index) {
  const context = "App manifest";
  const normalized = requireObject(junction, `areas[0].junctions[${index}]`, { context });
  const location = requireObject(normalized.location, `areas[0].junctions[${index}].location`, {
    context,
  });
  requireString(normalized.id, `areas[0].junctions[${index}].id`, { context });
  requireString(normalized.name, `areas[0].junctions[${index}].name`, { context });
  requireFiniteNumber(location.lat, `areas[0].junctions[${index}].location.lat`, { context });
  requireFiniteNumber(location.lon, `areas[0].junctions[${index}].location.lon`, { context });
  requireInteger(normalized.graph_node_id, `areas[0].junctions[${index}].graph_node_id`, {
    context,
  });
  requireArray(normalized.tags ?? [], `areas[0].junctions[${index}].tags`, { context });
  return normalized;
}

function validateScenario(scenario, index, junctionIds) {
  const context = "App manifest";
  const normalized = requireObject(scenario, `areas[0].scenarios[${index}]`, { context });
  requireString(normalized.id, `areas[0].scenarios[${index}].id`, { context });
  const startJunctionId = requireString(
    normalized.start_junction_id,
    `areas[0].scenarios[${index}].start_junction_id`,
    { context }
  );
  const endJunctionId = requireString(
    normalized.end_junction_id,
    `areas[0].scenarios[${index}].end_junction_id`,
    { context }
  );
  if (!junctionIds.has(startJunctionId)) {
    throw new Error(`App manifest scenario ${normalized.id} references unknown start junction ${startJunctionId}`);
  }
  if (!junctionIds.has(endJunctionId)) {
    throw new Error(`App manifest scenario ${normalized.id} references unknown end junction ${endJunctionId}`);
  }
  if (typeof normalized.is_loop !== "boolean") {
    throw new Error(`App manifest is missing valid areas[0].scenarios[${index}].is_loop`);
  }
  return normalized;
}

function validateArea(area, index) {
  const context = "App manifest";
  const normalized = requireObject(area, `areas[${index}]`, { context });
  requireString(normalized.id, `areas[${index}].id`, { context });
  requireString(normalized.name, `areas[${index}].name`, { context });
  requireArray(normalized.bounds, `areas[${index}].bounds`, { context });
  if (normalized.bounds.length !== 4) {
    throw new Error(`App manifest is missing valid areas[${index}].bounds`);
  }
  normalized.bounds.forEach((value, boundsIndex) => {
    requireFiniteNumber(value, `areas[${index}].bounds[${boundsIndex}]`, { context });
  });
  const junctions = requireArray(normalized.junctions, `areas[${index}].junctions`, { context });
  if (junctions.length === 0) {
    throw new Error(`App manifest must contain at least one junction in areas[${index}]`);
  }
  junctions.forEach(validateJunction);
  const junctionIds = new Set(junctions.map((junction) => junction.id));
  const scenarios = requireArray(normalized.scenarios, `areas[${index}].scenarios`, { context });
  if (scenarios.length === 0) {
    throw new Error(`App manifest must contain at least one scenario in areas[${index}]`);
  }
  scenarios.forEach((scenario, scenarioIndex) => validateScenario(scenario, scenarioIndex, junctionIds));
  return normalized;
}

export function validateAppManifest(manifest) {
  const context = "App manifest";
  const normalized = requireObject(manifest, "root object", { context });
  requireObject(normalized.meta ?? {}, "meta", { context });
  const planner = requireObject(normalized.planner, "planner", { context });
  requireString(planner.network_path, "planner.network_path", { context });
  requireString(planner.network_version, "planner.network_version", { context });
  requireObject(planner.config, "planner.config", { context });
  const areas = requireArray(normalized.areas, "areas", { context });
  if (areas.length === 0) {
    throw new Error("App manifest must contain at least one area");
  }
  areas.forEach(validateArea);
  return normalized;
}

export function validateEditorManifest(manifest) {
  const context = "Editor manifest";
  const normalized = requireObject(manifest, "root object", { context });
  const meta = requireObject(normalized.meta, "meta", { context });
  const editor = requireObject(normalized.editor, "editor", { context });
  requireString(meta.editor_graph_asset_id, "meta.editor_graph_asset_id", { context });
  requireString(meta.patchset_path, "meta.patchset_path", { context });
  requireString(meta.patchset_digest, "meta.patchset_digest", { context });
  requireString(meta.generated_at, "meta.generated_at", { context });
  requireString(editor.network_path, "editor.network_path", { context });
  requireString(editor.network_version, "editor.network_version", { context });
  return normalized;
}
