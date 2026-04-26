const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route network contracts module");
const {
  requireArray,
  requireCoordinatePair,
  requireFiniteNumber,
  requireInteger,
  requireObject,
} = await import(`./contract-primitives.mjs${moduleSuffix}`);

function roundCoordinate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function failNetwork(message) {
  throw new Error(`Invalid route network: ${message}`);
}

function requireNetworkArray(value, label) {
  try {
    return requireArray(value, label);
  } catch (error) {
    failNetwork(error.message);
  }
}

function requireNetworkObject(value, label) {
  try {
    return requireObject(value, label);
  } catch (error) {
    failNetwork(error.message);
  }
}

function requireNetworkFiniteNumber(value, label) {
  try {
    return requireFiniteNumber(value, label, { coerce: true });
  } catch (error) {
    failNetwork(error.message);
  }
}

function requireNetworkInteger(value, label) {
  try {
    return requireInteger(value, label, { coerce: true });
  } catch (error) {
    failNetwork(error.message);
  }
}

function requireRoundedCoordinatePair(value, label) {
  const pair = requireNetworkArray(value, label);
  if (pair.length !== 2) {
    failNetwork(`${label} must be a [lon, lat] coordinate pair`);
  }
  return [
    roundCoordinate(requireNetworkFiniteNumber(pair[0], `${label}[0]`)),
    roundCoordinate(requireNetworkFiniteNumber(pair[1], `${label}[1]`)),
  ];
}

function normalizeFeature(feature, index) {
  requireNetworkObject(feature, `features[${index}]`);
  if (feature.type !== "Feature") {
    failNetwork(`features[${index}].type must be "Feature"`);
  }

  const properties = requireNetworkObject(feature.properties, `features[${index}].properties`);
  const geometry = requireNetworkObject(feature.geometry, `features[${index}].geometry`);
  if (geometry.type !== "LineString") {
    failNetwork(`features[${index}].geometry.type must be "LineString"`);
  }

  const coordinates = requireNetworkArray(
    geometry.coordinates,
    `features[${index}].geometry.coordinates`,
  ).map((coordinate, coordinateIndex) =>
    requireRoundedCoordinatePair(coordinate, `features[${index}].geometry.coordinates[${coordinateIndex}]`)
  );
  if (coordinates.length < 2) {
    failNetwork(`features[${index}].geometry.coordinates must contain at least two points`);
  }

  const nodeIds = requireNetworkArray(
    properties.node_ids,
    `features[${index}].properties.node_ids`,
  ).map((value, nodeIndex) =>
    requireNetworkInteger(value, `features[${index}].properties.node_ids[${nodeIndex}]`)
  );
  if (nodeIds.length < 2) {
    failNetwork(`features[${index}].properties.node_ids must contain at least two ids`);
  }
  if (nodeIds.length !== coordinates.length) {
    failNetwork(`features[${index}] node_ids and coordinates must have the same length`);
  }

  const endpointNodeIds = requireNetworkArray(
    properties.endpoint_node_ids,
    `features[${index}].properties.endpoint_node_ids`,
  ).map((value, endpointIndex) =>
    requireNetworkInteger(value, `features[${index}].properties.endpoint_node_ids[${endpointIndex}]`)
  );
  if (endpointNodeIds.length !== 2) {
    failNetwork(`features[${index}].properties.endpoint_node_ids must contain exactly two ids`);
  }
  if (endpointNodeIds[0] !== nodeIds[0] || endpointNodeIds[1] !== nodeIds[nodeIds.length - 1]) {
    failNetwork(`features[${index}] endpoint_node_ids must match the first and last node_ids`);
  }

  let elevations = null;
  if (properties.elevations_m !== undefined) {
    elevations = requireNetworkArray(
      properties.elevations_m,
      `features[${index}].properties.elevations_m`,
    ).map((value, elevationIndex) =>
      requireNetworkFiniteNumber(value, `features[${index}].properties.elevations_m[${elevationIndex}]`)
    );
    if (elevations.length !== nodeIds.length) {
      failNetwork(`features[${index}] elevations_m must have the same length as node_ids`);
    }
  }

  const tags = requireNetworkObject(properties.tags, `features[${index}].properties.tags`);
  return {
    properties: {
      contig_id: requireNetworkInteger(properties.contig_id, `features[${index}].properties.contig_id`),
      endpoint_node_ids: endpointNodeIds,
      node_ids: nodeIds,
      length_m: requireNetworkFiniteNumber(properties.length_m, `features[${index}].properties.length_m`),
      segment_count: requireNetworkInteger(
        properties.segment_count,
        `features[${index}].properties.segment_count`,
      ),
      way_ids: requireNetworkArray(
        properties.way_ids,
        `features[${index}].properties.way_ids`,
      ).map((value, wayIndex) =>
        requireNetworkInteger(value, `features[${index}].properties.way_ids[${wayIndex}]`)
      ),
      way_names: requireNetworkArray(
        properties.way_names,
        `features[${index}].properties.way_names`,
      ).map((value, wayNameIndex) => String(
        value ?? failNetwork(`features[${index}].properties.way_names[${wayNameIndex}] must be present`)
      )),
      tags,
      ...(elevations ? { elevations_m: elevations } : {}),
    },
    geometry: {
      type: "LineString",
      coordinates,
    },
  };
}

export function normalizeRouteNetworkFeatureCollection(payload) {
  requireNetworkObject(payload, "payload");
  if (payload.type !== "FeatureCollection") {
    failNetwork('payload.type must be "FeatureCollection"');
  }
  return requireNetworkArray(payload.features, "payload.features").map(normalizeFeature);
}
