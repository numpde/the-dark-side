function scenarioHistoryKey(area, scenario) {
  return `${area.id}:${scenario.id}`;
}

function routeSequenceSignature(sequence) {
  return sequence.join(",");
}

export function recentRoutesForScenario(routeHistoryByScenario, area, scenario) {
  return routeHistoryByScenario.get(scenarioHistoryKey(area, scenario)) || [];
}

export function rememberRouteForScenario(routeHistoryByScenario, area, scenario, route) {
  const sequence = Array.isArray(route?.contig_id_sequence)
    ? route.contig_id_sequence.map((value) => Number(value))
    : [];
  if (!sequence.length) {
    return;
  }
  const key = scenarioHistoryKey(area, scenario);
  const existing = recentRoutesForScenario(routeHistoryByScenario, area, scenario);
  const signature = routeSequenceSignature(sequence);
  const updated = existing.filter((item) => routeSequenceSignature(item) !== signature);
  updated.unshift(sequence);
  routeHistoryByScenario.set(key, updated.slice(0, 12));
}

export function findScenario(area, startJunctionId, endJunctionId) {
  if (!area) {
    return null;
  }
  return area.scenarios.find(
    (item) => item.start_junction_id === startJunctionId && item.end_junction_id === endJunctionId
  ) || null;
}

export function requireScenario(area, startJunctionId, endJunctionId, label = "scenario selection") {
  const scenario = findScenario(area, startJunctionId, endJunctionId);
  if (!scenario) {
    throw new Error(`Invalid ${label}: ${startJunctionId} -> ${endJunctionId}`);
  }
  return scenario;
}

export function junctionById(area, junctionId) {
  const junction = area.junctions.find((item) => item.id === junctionId);
  if (!junction) {
    throw new Error(`Unknown junction id ${junctionId}`);
  }
  return junction;
}

export function junctionsForScenario(area, scenario) {
  return {
    startJunction: junctionById(area, scenario.start_junction_id),
    endJunction: junctionById(area, scenario.end_junction_id),
  };
}

export function scenarioLabelText(scenario, area) {
  const start = junctionById(area, scenario.start_junction_id);
  const end = junctionById(area, scenario.end_junction_id);
  if (scenario.is_loop) {
    return `${start.name} loop`;
  }
  return `${start.name} to ${end.name}`;
}

export function resolveCanonicalSelection(manifest, search) {
  const query = new URLSearchParams(search);
  const areas = manifest.areas;
  const requestedAreaId = query.get("area");
  const requestedArea = areas.find((item) => item.id === requestedAreaId);
  const area = requestedArea ?? areas[0];
  const requestedStart = query.get("start");
  const requestedEnd = query.get("end");
  const { scenario } = resolveScenarioSelection(area, {
    startJunctionId: requestedStart,
    endJunctionId: requestedEnd,
    preferredAnchor: "exact",
  });
  const canonical = {
    areaId: area.id,
    startJunctionId: scenario.start_junction_id,
    endJunctionId: scenario.end_junction_id,
  };
  const queryState = {
    areaId: requestedAreaId,
    startJunctionId: requestedStart,
    endJunctionId: requestedEnd,
  };
  return {
    area,
    scenario,
    canonical,
    canonicalized:
      queryState.areaId !== canonical.areaId
      || queryState.startJunctionId !== canonical.startJunctionId
      || queryState.endJunctionId !== canonical.endJunctionId,
  };
}

export function resolveScenarioSelection(
  area,
  {
    startJunctionId = null,
    endJunctionId = null,
    preferredAnchor = "exact",
  } = {},
) {
  const exactScenario = findScenario(area, startJunctionId, endJunctionId);
  if (exactScenario) {
    return {
      scenario: exactScenario,
      canonicalized: false,
    };
  }

  const byStart = startJunctionId
    ? area.scenarios.find((item) => item.start_junction_id === startJunctionId) || null
    : null;
  const byEnd = endJunctionId
    ? area.scenarios.find((item) => item.end_junction_id === endJunctionId) || null
    : null;

  let scenario = area.scenarios[0];
  if (preferredAnchor === "start" && byStart) {
    scenario = byStart;
  } else if (preferredAnchor === "end" && byEnd) {
    scenario = byEnd;
  } else {
    scenario = byStart || byEnd || area.scenarios[0];
  }

  return {
    scenario,
    canonicalized: true,
  };
}
