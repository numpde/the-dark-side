const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route graph module");
const { normalizeRouteNetworkFeatureCollection } = await import(`./route-network-contracts.mjs${moduleSuffix}`);

function haversineMeters(lonA, latA, lonB, latB) {
  const toRad = Math.PI / 180;
  const dLat = (latB - latA) * toRad;
  const dLon = (lonB - lonA) * toRad;
  const aLat = latA * toRad;
  const bLat = latB * toRad;
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000.0 * Math.asin(Math.sqrt(value));
}

function cumulativeDistances(coordinates) {
  if (!coordinates.length) {
    return [];
  }
  const distances = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const first = coordinates[index - 1];
    const second = coordinates[index];
    distances.push(
      distances[distances.length - 1]
      + haversineMeters(first[0], first[1], second[0], second[1]),
    );
  }
  return distances;
}

function movingAverage(values, window) {
  if (window <= 1 || values.length <= 2) {
    return [...values];
  }
  const radius = Math.max(0, Math.floor(window / 2));
  return values.map((_, index) => {
    const left = Math.max(0, index - radius);
    const right = Math.min(values.length, index + radius + 1);
    const sample = values.slice(left, right);
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  });
}

function computeGainLoss(values, minStepM) {
  let gain = 0;
  let loss = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (Math.abs(delta) < minStepM) {
      continue;
    }
    if (delta > 0) {
      gain += delta;
    } else {
      loss += -delta;
    }
  }
  return { gain, loss };
}

function roundCoordinate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundMeters(value) {
  return Math.round(value * 1000) / 1000;
}

function buildBounds(coordinates) {
  const lons = coordinates.map((coordinate) => coordinate[0]);
  const lats = coordinates.map((coordinate) => coordinate[1]);
  return [
    roundCoordinate(Math.min(...lons)),
    roundCoordinate(Math.min(...lats)),
    roundCoordinate(Math.max(...lons)),
    roundCoordinate(Math.max(...lats)),
  ];
}

function nodeCoordinate(coordinate) {
  return [roundCoordinate(coordinate[0]), roundCoordinate(coordinate[1])];
}

function findArticulationPoints(adjacency) {
  const graph = new Map();
  for (const [nodeId, edges] of adjacency.entries()) {
    graph.set(nodeId, new Set(edges.map(([, neighbor]) => neighbor).filter((neighbor) => neighbor !== nodeId)));
  }

  const discovery = new Map();
  const low = new Map();
  const parent = new Map();
  const articulation = new Set();
  let time = 0;

  function visit(nodeId) {
    time += 1;
    discovery.set(nodeId, time);
    low.set(nodeId, time);
    let childCount = 0;

    const neighbors = [...(graph.get(nodeId) || [])].sort((a, b) => a - b);
    for (const neighbor of neighbors) {
      if (!discovery.has(neighbor)) {
        parent.set(neighbor, nodeId);
        childCount += 1;
        visit(neighbor);
        low.set(nodeId, Math.min(low.get(nodeId), low.get(neighbor)));
        if (!parent.has(nodeId) && childCount > 1) {
          articulation.add(nodeId);
        }
        if (parent.has(nodeId) && low.get(neighbor) >= discovery.get(nodeId)) {
          articulation.add(nodeId);
        }
      } else if (neighbor !== parent.get(nodeId)) {
        low.set(nodeId, Math.min(low.get(nodeId), discovery.get(neighbor)));
      }
    }
  }

  for (const nodeId of [...graph.keys()].sort((a, b) => a - b)) {
    if (discovery.has(nodeId)) {
      continue;
    }
    parent.delete(nodeId);
    visit(nodeId);
  }

  return articulation;
}

export function buildGraphFromGeoJson(payload) {
  const features = normalizeRouteNetworkFeatureCollection(payload);
  const nodes = new Map();
  const contigs = new Map();
  const adjacency = new Map();

  for (const feature of features) {
    const properties = feature.properties;
    const coordinates = feature.geometry.coordinates;
    const nodeIds = properties.node_ids;
    const endpointNodeIds = properties.endpoint_node_ids;
    const elevations = Array.isArray(properties.elevations_m) ? properties.elevations_m : null;

    const contig = {
      id: properties.contig_id,
      endpointNodeIds,
      nodeIds,
      coordinates: coordinates.map(nodeCoordinate),
      elevations: elevations && elevations.length === nodeIds.length
        ? elevations.map((value) => Number(value))
        : null,
      lengthM: properties.length_m,
      segmentCount: properties.segment_count,
      wayIds: properties.way_ids,
      wayNames: [...properties.way_names],
      tags: { ...properties.tags },
      isCycle: endpointNodeIds[0] === endpointNodeIds[1],
    };
    if (contigs.has(contig.id)) {
      throw new Error(`Invalid route network: duplicate contig_id ${contig.id}`);
    }
    contigs.set(contig.id, contig);

    nodeIds.forEach((nodeId, index) => {
      if (!nodes.has(nodeId)) {
        nodes.set(nodeId, {
          id: nodeId,
          lon: contig.coordinates[index][0],
          lat: contig.coordinates[index][1],
          elevationM: contig.elevations ? contig.elevations[index] : null,
        });
        return;
      }
      const existing = nodes.get(nodeId);
      if (existing.elevationM == null && contig.elevations) {
        existing.elevationM = contig.elevations[index];
      }
    });

    const [firstNodeId, secondNodeId] = endpointNodeIds;
    if (!adjacency.has(firstNodeId)) {
      adjacency.set(firstNodeId, []);
    }
    adjacency.get(firstNodeId).push([contig.id, secondNodeId]);
    if (firstNodeId !== secondNodeId) {
      if (!adjacency.has(secondNodeId)) {
        adjacency.set(secondNodeId, []);
      }
      adjacency.get(secondNodeId).push([contig.id, firstNodeId]);
    }
  }

  for (const [nodeId, node] of nodes.entries()) {
    node.degree = (adjacency.get(nodeId) || []).length;
  }

  return {
    nodes,
    contigs,
    adjacency,
    articulationPoints: findArticulationPoints(adjacency),
  };
}

function orientContigNodeIds(contig, fromNodeId, toNodeId) {
  if (contig.isCycle) {
    return [...contig.nodeIds];
  }
  if (contig.nodeIds[0] === fromNodeId && contig.nodeIds[contig.nodeIds.length - 1] === toNodeId) {
    return [...contig.nodeIds];
  }
  if (contig.nodeIds[0] === toNodeId && contig.nodeIds[contig.nodeIds.length - 1] === fromNodeId) {
    return [...contig.nodeIds].reverse();
  }
  throw new Error(`Contig ${contig.id} cannot be oriented for ${fromNodeId}->${toNodeId}`);
}

function buildRouteNodeIds(graph, steps) {
  const routeNodeIds = [];
  for (const step of steps) {
    const contig = graph.contigs.get(step.contigId);
    const oriented = orientContigNodeIds(contig, step.fromNodeId, step.toNodeId);
    if (!routeNodeIds.length) {
      routeNodeIds.push(...oriented);
      continue;
    }
    routeNodeIds.push(...oriented.slice(1));
  }
  return routeNodeIds;
}

function summarizeRouteElevations(coordinates, elevations, config) {
  const smoothed = movingAverage(elevations, config.elevation_smoothing_window);
  const { gain, loss } = computeGainLoss(smoothed, config.elevation_min_step_m);
  return {
    elevationsM: smoothed.map((value) => Math.round(value * 10) / 10),
    elevationGainM: Math.round(gain * 10) / 10,
    elevationLossM: Math.round(loss * 10) / 10,
    elevationMinM: Math.round(Math.min(...smoothed) * 10) / 10,
    elevationMaxM: Math.round(Math.max(...smoothed) * 10) / 10,
    totalDistanceM: cumulativeDistances(coordinates).at(-1) || 0,
  };
}

function repeatedContigIds(steps) {
  const visits = new Set();
  const repeated = [];
  for (const step of steps) {
    if (visits.has(step.contigId) && !repeated.includes(step.contigId)) {
      repeated.push(step.contigId);
    }
    visits.add(step.contigId);
  }
  return repeated;
}

export function buildRoutePayload(graph, primary, { routeId, seed, algorithm, config }) {
  const routeNodeIds = buildRouteNodeIds(graph, primary.steps);
  const coordinates = routeNodeIds.map((nodeId) => {
    const node = graph.nodes.get(nodeId);
    return [roundCoordinate(node.lon), roundCoordinate(node.lat)];
  });
  const elevations = routeNodeIds.map((nodeId) => graph.nodes.get(nodeId)?.elevationM);
  const hasCompleteElevation = elevations.every((value) => typeof value === "number");
  const elevationSummary = hasCompleteElevation
    ? summarizeRouteElevations(coordinates, elevations, config)
    : null;

  return {
    id: routeId,
    algorithm,
    seed,
    complete: primary.complete,
    score: roundMeters(primary.score),
    total_length_m: roundMeters(primary.totalLengthM),
    unique_length_m: roundMeters(primary.uniqueLengthM),
    overlap_length_m: roundMeters(primary.overlapLengthM),
    step_count: primary.steps.length,
    repeated_contig_ids: repeatedContigIds(primary.steps),
    bounds: buildBounds(coordinates),
    coordinates,
    route_node_ids: routeNodeIds,
    contig_id_sequence: primary.steps.map((step) => step.contigId),
    ...(elevationSummary
      ? {
          elevations_m: elevationSummary.elevationsM,
          elevation_gain_m: elevationSummary.elevationGainM,
          elevation_loss_m: elevationSummary.elevationLossM,
          elevation_min_m: elevationSummary.elevationMinM,
          elevation_max_m: elevationSummary.elevationMaxM,
        }
      : {}),
  };
}
