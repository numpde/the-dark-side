import {
  requireCoordinatePair,
  requireFiniteNumber,
  requireInteger,
  requireIntegerArray,
  requireObject,
  requireString,
} from "./contract-primitives.mjs";

export function requireRouteHistory(value, label) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of contig-id sequences`);
  }
  return value.map((item, index) => requireIntegerArray(item, `${label}[${index}]`));
}

export function parsePlannerWorkerRequest(data) {
  const message = requireObject(data, "Worker request");
  return {
    type: requireString(message.type, "Worker request type"),
    requestId: requireInteger(message.requestId, "Worker request requestId"),
    payload: requireObject(message.payload, "Worker request payload"),
  };
}

export function validatePlannerWorkerInitPayload(payload) {
  return {
    network: requireObject(payload.network, "Route worker init payload.network"),
    config: requireObject(payload.config, "Route worker init payload.config"),
  };
}

export function validatePlannerWorkerPlanPayload(payload) {
  return {
    routeId: requireString(payload.routeId, "Route worker plan payload.routeId"),
    startNodeId: requireInteger(payload.startNodeId, "Route worker plan payload.startNodeId"),
    endNodeId: requireInteger(payload.endNodeId, "Route worker plan payload.endNodeId"),
    seed: requireInteger(payload.seed, "Route worker plan payload.seed"),
    recentRouteContigSequences: requireRouteHistory(
      payload.recentRouteContigSequences,
      "Route worker plan payload.recentRouteContigSequences",
    ),
  };
}

export function validatePlannerRoutePayload(payload, label = "worker route payload") {
  const route = requireObject(payload, label);
  requireString(route.id, `${label}.id`);
  requireString(route.algorithm, `${label}.algorithm`);
  requireInteger(route.seed, `${label}.seed`);
  if (typeof route.complete !== "boolean") {
    throw new Error(`${label}.complete must be a boolean`);
  }
  requireFiniteNumber(route.score, `${label}.score`);
  requireFiniteNumber(route.total_length_m, `${label}.total_length_m`);
  requireFiniteNumber(route.unique_length_m, `${label}.unique_length_m`);
  requireFiniteNumber(route.overlap_length_m, `${label}.overlap_length_m`);
  requireInteger(route.step_count, `${label}.step_count`);
  requireIntegerArray(route.repeated_contig_ids ?? [], `${label}.repeated_contig_ids`);
  if (!Array.isArray(route.bounds) || route.bounds.length !== 4) {
    throw new Error(`${label}.bounds must contain four numbers`);
  }
  route.bounds.forEach((value, index) => requireFiniteNumber(value, `${label}.bounds[${index}]`));
  if (!Array.isArray(route.coordinates) || route.coordinates.length < 2) {
    throw new Error(`${label}.coordinates must contain at least two coordinate pairs`);
  }
  route.coordinates.forEach((pair, index) => requireCoordinatePair(pair, `${label}.coordinates[${index}]`));
  requireIntegerArray(route.route_node_ids, `${label}.route_node_ids`);
  requireIntegerArray(route.contig_id_sequence, `${label}.contig_id_sequence`);
  if (route.elevations_m !== undefined) {
    if (!Array.isArray(route.elevations_m)) {
      throw new Error(`${label}.elevations_m must be an array`);
    }
    route.elevations_m.forEach((value, index) =>
      requireFiniteNumber(value, `${label}.elevations_m[${index}]`));
    requireFiniteNumber(route.elevation_gain_m, `${label}.elevation_gain_m`);
    requireFiniteNumber(route.elevation_loss_m, `${label}.elevation_loss_m`);
    requireFiniteNumber(route.elevation_min_m, `${label}.elevation_min_m`);
    requireFiniteNumber(route.elevation_max_m, `${label}.elevation_max_m`);
  }
  return route;
}

export function parsePlannerWorkerResponse(data) {
  const message = requireObject(data, "worker message");
  const type = requireString(message.type, "worker message type");
  const requestId = requireInteger(message.requestId, "worker requestId");

  if (type === "error") {
    const payload = requireObject(message.payload, "worker error payload");
    return {
      requestId,
      type,
      payload: {
        message: requireString(payload.message, "worker error payload.message"),
      },
    };
  }

  if (type === "ready") {
    const payload = requireObject(message.payload, "worker ready payload");
    return {
      requestId,
      type,
      payload: {
        contigCount: requireInteger(payload.contigCount, "worker ready payload.contigCount"),
        nodeCount: requireInteger(payload.nodeCount, "worker ready payload.nodeCount"),
      },
    };
  }

  if (type === "progress" || type === "planned") {
    return {
      requestId,
      type,
      payload: validatePlannerRoutePayload(message.payload, `worker ${type} payload`),
    };
  }

  throw new Error(`Unknown worker message: ${type}`);
}
