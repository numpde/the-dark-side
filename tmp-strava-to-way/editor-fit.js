import { TRACE_WAY_SOURCE } from "./editor-config.js?v=20260427aw";

const EARTH_RADIUS_METERS = 6378137;

export const FIT_MODE_OPTIONS = {
  "axis-aligned": {
    label: "Axis-aligned",
    minControlPoints: 2,
    solve: fitAxisAligned,
  },
  similarity: {
    label: "Similarity",
    minControlPoints: 2,
    solve: fitSimilarity,
  },
  affine: {
    label: "Affine",
    minControlPoints: 3,
    solve: fitAffine,
  },
};

export function getFitModeConfig(fitModeKey = "axis-aligned") {
  const fitMode = FIT_MODE_OPTIONS[fitModeKey] ?? FIT_MODE_OPTIONS["axis-aligned"];
  return {
    key: fitModeKey in FIT_MODE_OPTIONS ? fitModeKey : "axis-aligned",
    ...fitMode,
  };
}

export function buildFitResult({ figure, fitModeKey, fit, points }) {
  const corners = projectFigureCorners(figure, fit);
  const controlPoints = buildFitControlPoints(points);
  const residuals = buildFitResiduals(points, fit);
  const residualValues = residuals.map((item) => item.residualMeters);
  return {
    fitModel: serializeFitModel(fit),
    polygonLatLngs: corners.map((corner) => [corner.lat, corner.lon]),
    output: {
      figureId: figure.id,
      figureLabel: figure.label,
      sourceUrl: figure.sourceUrl,
      fitMode: fitModeKey,
      controlPointCount: points.length,
      controlPoints,
      residualSummaryMeters: {
        mean: roundTo(mean(residualValues), 3),
        max: roundTo(Math.max(...residualValues), 3),
      },
      residuals,
      corners,
      inferredBounds: cornersToBounds(corners),
      transform: describeFit(fit),
    },
  };
}

export function projectImagePointToLatLon(fitRecord, imageX, imageY) {
  const fitModel = getFitModelFromRecord(fitRecord);
  if (!fitModel) {
    throw new Error("This figure does not have a usable fit yet.");
  }
  const projected = applyFit(fitModel, imageX, imageY);
  return mercatorMetersToLatLon(projected.x, projected.y);
}

export function projectLatLonToImagePoint(fitRecord, lat, lon) {
  const fitModel = getFitModelFromRecord(fitRecord);
  if (!fitModel) {
    throw new Error("This figure does not have a usable fit yet.");
  }
  const projected = latLonToMercatorMeters(lat, lon);
  const image = applyInverseFit(fitModel, projected.x, projected.y);
  return {
    x: roundTo(image.x, 2),
    y: roundTo(image.y, 2),
  };
}

export function resolveTraceVertexPlacement(trace, wayId, vertexId) {
  const resolvedRef = resolveTraceVertexReference(trace, wayId, vertexId);
  if (!resolvedRef) {
    return null;
  }
  const { way, vertex } = resolvedRef;
  return {
    wayId: way.id,
    vertexId: vertex.id,
    x: vertex.x,
    y: vertex.y,
    osmNodeId: vertex.osmNodeId ?? null,
    osmLat: vertex.osmLat ?? null,
    osmLon: vertex.osmLon ?? null,
    segmentSnap: vertex.segmentSnap ?? null,
  };
}

export function traceVertexSnapWouldCycle(trace, sourceWayId, sourceVertexId, targetWayId, targetVertexId) {
  if (sourceWayId == null || sourceVertexId == null || targetWayId == null || targetVertexId == null) {
    return false;
  }
  if (sourceWayId === targetWayId && sourceVertexId === targetVertexId) {
    return true;
  }
  const visited = new Set();
  let currentWayId = targetWayId;
  let currentVertexId = targetVertexId;
  while (true) {
    const visitKey = `${currentWayId}:${currentVertexId}`;
    if (visited.has(visitKey)) {
      return false;
    }
    visited.add(visitKey);
    if (currentWayId === sourceWayId && currentVertexId === sourceVertexId) {
      return true;
    }
    const way = trace.ways.find((candidate) => candidate.id === currentWayId);
    const vertex = way?.vertices.find((candidate) => candidate.id === currentVertexId) ?? null;
    if (!vertex?.traceVertexSnap) {
      return false;
    }
    currentWayId = vertex.traceVertexSnap.wayId;
    currentVertexId = vertex.traceVertexSnap.vertexId;
  }
}

export function buildTraceOsmExport({ figure, fitRecord, trace, regionGeoJsonData, selectedWayId = null }) {
  const fitModel = getFitModelFromRecord(fitRecord);
  if (!fitModel) {
    throw new Error("Trace export requires a fit result.");
  }

  const regionWaysById = new Map(
    (regionGeoJsonData?.features || []).map((feature) => [feature?.properties?.way_id, feature])
  );

  const traceWays = selectTraceExportWays(trace, selectedWayId);

  const draftWays = traceWays.map((way) => ({
    wayId: way.id,
    tags: buildDraftWayTags(way.tags),
    vertices: way.vertices.map((vertex) => {
      const resolved = resolveTraceVertexPlacement(trace, way.id, vertex.id);
      const imageX = resolved?.x ?? vertex.x;
      const imageY = resolved?.y ?? vertex.y;
      const latLon =
        resolved?.osmNodeId && resolved?.osmLat != null && resolved?.osmLon != null
          ? { lat: resolved.osmLat, lon: resolved.osmLon }
          : resolved?.osmLat != null && resolved?.osmLon != null
            ? { lat: resolved.osmLat, lon: resolved.osmLon }
            : projectImagePointToLatLon({ fitModel }, imageX, imageY);
      return {
        vertexId: vertex.id,
        resolvedWayId: resolved?.wayId ?? way.id,
        resolvedVertexId: resolved?.vertexId ?? vertex.id,
        osmNodeId: resolved?.osmNodeId ?? null,
        segmentSnap: resolved?.segmentSnap ?? null,
        image: {
          x: roundTo(imageX, 2),
          y: roundTo(imageY, 2),
        },
        map: {
          lat: roundTo(latLon.lat, 7),
          lon: roundTo(latLon.lon, 7),
        },
      };
    }),
  }));

  const exportableWays = draftWays.filter((way) => way.vertices.length >= 2);
  const skippedWays = draftWays.filter((way) => way.vertices.length < 2).map((way) => way.wayId);
  let nextNodeId = -1;
  const modifiedWayInsertions = new Map();
  const assignedNodesByResolvedVertex = new Map();
  const createdNodes = [];

  const draftWayPayloads = exportableWays.map((way) => ({
    sourceWayId: way.wayId,
    tags: way.tags,
    nodes: way.vertices.map((vertex) => {
      const resolvedVertexKey = `${vertex.resolvedWayId}:${vertex.resolvedVertexId}`;
      if (assignedNodesByResolvedVertex.has(resolvedVertexKey)) {
        return assignedNodesByResolvedVertex.get(resolvedVertexKey);
      }
      if (vertex.osmNodeId) {
        const node = {
          nodeId: vertex.osmNodeId,
          existing: true,
          ...vertex,
        };
        assignedNodesByResolvedVertex.set(resolvedVertexKey, node);
        return node;
      }
      const node = {
        nodeId: nextNodeId--,
        existing: false,
        ...vertex,
      };
      createdNodes.push(node);
      if (vertex.segmentSnap) {
        rememberSegmentInsertion(modifiedWayInsertions, vertex.segmentSnap, node.nodeId);
      }
      assignedNodesByResolvedVertex.set(resolvedVertexKey, node);
      return node;
    }),
  }));

  let nextWayId = nextNodeId;
  const osmWays = draftWayPayloads.map((way) => ({
    ...way,
    wayId: nextWayId--,
  }));

  const modifiedWays = buildModifiedWays(modifiedWayInsertions, regionWaysById);

  return {
    figureId: figure.id,
    figureLabel: figure.label,
    sourceUrl: figure.sourceUrl,
    selectedWayId,
    fitMode: fitRecord?.output?.fitMode ?? fitModel.type,
    wayCount: osmWays.length,
    modifiedWayCount: modifiedWays.length,
    skippedWays,
    ways: osmWays,
    modifiedWays,
    createdNodes,
    osmXml: buildOsmXml({ figure, createdNodes, ways: osmWays, modifiedWays }),
    osmChangeXml: buildOsmChangeXml({ createdNodes, ways: osmWays, modifiedWays }),
  };
}

function buildFitControlPoints(points) {
  return points.map((point) => ({
    pointId: point.id,
    image: {
      x: roundTo(point.image.x, 2),
      y: roundTo(point.image.y, 2),
    },
    map: {
      lat: roundTo(point.map.lat, 7),
      lon: roundTo(point.map.lon, 7),
    },
  }));
}

function serializeFitModel(fit) {
  if (fit.type === "axis-aligned") {
    return {
      type: fit.type,
      xScale: fit.xScale,
      xOffset: fit.xOffset,
      yScale: fit.yScale,
      yOffset: fit.yOffset,
    };
  }
  if (fit.type === "similarity") {
    return {
      type: fit.type,
      a: fit.a,
      b: fit.b,
      tx: fit.tx,
      ty: fit.ty,
    };
  }
  return {
    type: fit.type,
    a: fit.a,
    b: fit.b,
    c: fit.c,
    d: fit.d,
    tx: fit.tx,
    ty: fit.ty,
  };
}

function getFitModelFromRecord(fitRecord) {
  if (!fitRecord) {
    return null;
  }
  if (fitRecord.fitModel?.type) {
    return fitRecord.fitModel;
  }
  const transform = fitRecord.output?.transform;
  if (!transform?.type) {
    return null;
  }
  if (transform.type === "axis-aligned") {
    return {
      type: transform.type,
      xScale: transform.xMetersPerPixel,
      xOffset: transform.xOffsetMeters,
      yScale: transform.yMetersPerPixel,
      yOffset: transform.yOffsetMeters,
    };
  }
  if (transform.type === "similarity") {
    return {
      type: transform.type,
      a: transform.a,
      b: transform.b,
      tx: transform.txMeters,
      ty: transform.tyMeters,
    };
  }
  return {
    type: transform.type,
    a: transform.a,
    b: transform.b,
    c: transform.c,
    d: transform.d,
    tx: transform.txMeters,
    ty: transform.tyMeters,
  };
}

function buildOsmXml({ figure, createdNodes, ways, modifiedWays }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<osm version="0.6" generator="Strava to Way Fit Editor">`,
    `  <!-- Draft traced from ${escapeXml(figure.label)} -->`,
    `  <!-- ${escapeXml(figure.sourceUrl)} -->`,
  ];

  for (const node of createdNodes) {
    lines.push(
      `  <node id="${node.nodeId}" visible="true" lat="${node.map.lat.toFixed(7)}" lon="${node.map.lon.toFixed(7)}" />`
    );
  }

  for (const way of modifiedWays) {
    lines.push(`  <way id="${way.wayId}" version="${way.version}" visible="true">`);
    for (const nodeRef of way.nodeRefs) {
      lines.push(`    <nd ref="${nodeRef}" />`);
    }
    for (const tag of way.tags) {
      lines.push(`    <tag k="${escapeXml(tag.key)}" v="${escapeXml(tag.value)}" />`);
    }
    lines.push("  </way>");
  }

  for (const way of ways) {
    lines.push(`  <way id="${way.wayId}" visible="true">`);
    for (const node of way.nodes) {
      lines.push(`    <nd ref="${node.nodeId}" />`);
    }
    for (const tag of way.tags) {
      lines.push(`    <tag k="${escapeXml(tag.key)}" v="${escapeXml(tag.value)}" />`);
    }
    lines.push("  </way>");
  }

  lines.push("</osm>");
  return lines.join("\n");
}

function buildOsmChangeXml({ createdNodes, ways, modifiedWays }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<osmChange version="0.6" generator="Strava to Way Fit Editor">',
    "  <create>",
  ];

  for (const node of createdNodes) {
    lines.push(
      `    <node id="${node.nodeId}" lat="${node.map.lat.toFixed(7)}" lon="${node.map.lon.toFixed(7)}" />`
    );
  }

  for (const way of ways) {
    lines.push(`    <way id="${way.wayId}">`);
    for (const node of way.nodes) {
      lines.push(`      <nd ref="${node.nodeId}" />`);
    }
    for (const tag of way.tags) {
      lines.push(`      <tag k="${escapeXml(tag.key)}" v="${escapeXml(tag.value)}" />`);
    }
    lines.push("    </way>");
  }
  lines.push("  </create>");

  lines.push("  <modify>");
  for (const way of modifiedWays) {
    lines.push(`    <way id="${way.wayId}" version="${way.version}">`);
    for (const nodeRef of way.nodeRefs) {
      lines.push(`      <nd ref="${nodeRef}" />`);
    }
    for (const tag of way.tags) {
      lines.push(`      <tag k="${escapeXml(tag.key)}" v="${escapeXml(tag.value)}" />`);
    }
    lines.push("    </way>");
  }
  lines.push("  </modify>");
  lines.push("</osmChange>");
  return lines.join("\n");
}

function buildDraftWayTags(wayTags = {}) {
  const tags = [{ key: "source", value: TRACE_WAY_SOURCE }];
  if (wayTags.highway) {
    tags.push({ key: "highway", value: wayTags.highway });
  }
  if (wayTags.foot) {
    tags.push({ key: "foot", value: wayTags.foot });
  }
  if (wayTags.bicycle) {
    tags.push({ key: "bicycle", value: wayTags.bicycle });
  }
  if (wayTags.mtbScale) {
    tags.push({ key: "mtb:scale", value: wayTags.mtbScale });
  }
  if (!wayTags.highway) {
    tags.push({ key: "fixme", value: "Add appropriate tags before upload" });
  }
  return tags;
}

function selectTraceExportWays(trace, selectedWayId) {
  if (selectedWayId == null) {
    return trace.ways;
  }
  const includedWayIds = new Set([selectedWayId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const way of trace.ways) {
      const touchesIncluded = way.vertices.some((vertex) => {
        const targetWayId = vertex.traceVertexSnap?.wayId;
        return targetWayId != null && (includedWayIds.has(way.id) || includedWayIds.has(targetWayId));
      });
      if (touchesIncluded && !includedWayIds.has(way.id)) {
        includedWayIds.add(way.id);
        changed = true;
      }
      for (const vertex of way.vertices) {
        const targetWayId = vertex.traceVertexSnap?.wayId;
        if (targetWayId != null && includedWayIds.has(way.id) && !includedWayIds.has(targetWayId)) {
          includedWayIds.add(targetWayId);
          changed = true;
        }
      }
    }
  }
  return trace.ways.filter((way) => includedWayIds.has(way.id));
}

function resolveTraceVertexReference(trace, wayId, vertexId) {
  const visited = new Set();
  let currentWayId = wayId;
  let currentVertexId = vertexId;
  while (true) {
    const visitKey = `${currentWayId}:${currentVertexId}`;
    if (visited.has(visitKey)) {
      break;
    }
    visited.add(visitKey);
    const way = trace.ways.find((candidate) => candidate.id === currentWayId);
    const vertex = way?.vertices.find((candidate) => candidate.id === currentVertexId) ?? null;
    if (!way || !vertex) {
      return null;
    }
    if (!vertex.traceVertexSnap) {
      return { way, vertex };
    }
    currentWayId = vertex.traceVertexSnap.wayId;
    currentVertexId = vertex.traceVertexSnap.vertexId;
  }
  return null;
}

function rememberSegmentInsertion(modifiedWayInsertions, segmentSnap, nodeId) {
  const insertions = modifiedWayInsertions.get(segmentSnap.wayId) ?? [];
  insertions.push({
    nodeId,
    segmentIndex: segmentSnap.segmentIndex,
    t: segmentSnap.t,
  });
  modifiedWayInsertions.set(segmentSnap.wayId, insertions);
}

function buildModifiedWays(modifiedWayInsertions, regionWaysById) {
  const modifiedWays = [];
  for (const [wayId, insertions] of modifiedWayInsertions.entries()) {
    const feature = regionWaysById.get(wayId);
    if (!feature) {
      throw new Error(`Missing source way ${wayId} for snapped segment export.`);
    }
    const nodeIds = [...(feature.properties?.node_ids || [])];
    const version = feature.properties?.way_version;
    if (!nodeIds.length || !version) {
      throw new Error(`Way ${wayId} is missing node_ids or version for export.`);
    }
    const insertionsBySegment = new Map();
    for (const insertion of insertions) {
      const segmentInsertions = insertionsBySegment.get(insertion.segmentIndex) ?? [];
      segmentInsertions.push(insertion);
      insertionsBySegment.set(insertion.segmentIndex, segmentInsertions);
    }
    const nodeRefs = [];
    for (let index = 0; index < nodeIds.length - 1; index += 1) {
      nodeRefs.push(nodeIds[index]);
      const segmentInsertions = insertionsBySegment.get(index);
      if (!segmentInsertions) {
        continue;
      }
      segmentInsertions.sort((left, right) => left.t - right.t);
      for (const insertion of segmentInsertions) {
        nodeRefs.push(insertion.nodeId);
      }
    }
    nodeRefs.push(nodeIds.at(-1));
    modifiedWays.push({
      wayId,
      version,
      nodeRefs,
      tags: extractWayTags(feature.properties || {}),
    });
  }
  return modifiedWays;
}

function extractWayTags(properties) {
  const ignoredKeys = new Set(["way_id", "way_version", "node_ids"]);
  return Object.entries(properties)
    .filter(([key, value]) => !ignoredKeys.has(key) && value != null && value !== "")
    .map(([key, value]) => ({ key, value: String(value) }));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function projectFigureCorners(figure, fit) {
  return [
    { name: "topLeft", image: [0, 0] },
    { name: "topRight", image: [figure.imageSize.width, 0] },
    { name: "bottomRight", image: [figure.imageSize.width, figure.imageSize.height] },
    { name: "bottomLeft", image: [0, figure.imageSize.height] },
  ].map((corner) => {
    const projected = applyFit(fit, corner.image[0], corner.image[1]);
    const latLon = mercatorMetersToLatLon(projected.x, projected.y);
    return {
      name: corner.name,
      lat: latLon.lat,
      lon: latLon.lon,
    };
  });
}

function buildFitResiduals(points, fit) {
  return points.map((point) => {
    const target = latLonToMercatorMeters(point.map.lat, point.map.lon);
    const fitted = applyFit(fit, point.image.x, point.image.y);
    return {
      pointId: point.id,
      residualMeters: roundTo(distance2d(target, fitted), 3),
    };
  });
}

function fitAxisAligned(points) {
  if (points.length < 2) {
    throw new Error("Axis-aligned fit needs at least 2 paired points");
  }
  const xFit = fitLine(points.map((point) => ({ input: point.image.x, output: latLonToMercatorMeters(point.map.lat, point.map.lon).x })));
  const yFit = fitLine(points.map((point) => ({ input: point.image.y, output: latLonToMercatorMeters(point.map.lat, point.map.lon).y })));
  return {
    type: "axis-aligned",
    xScale: xFit.slope,
    xOffset: xFit.intercept,
    yScale: yFit.slope,
    yOffset: yFit.intercept,
  };
}

function fitSimilarity(points) {
  if (points.length < 2) {
    throw new Error("Similarity fit needs at least 2 paired points");
  }
  const image = points.map((point) => [point.image.x, point.image.y]);
  const target = points.map((point) => {
    const meters = latLonToMercatorMeters(point.map.lat, point.map.lon);
    return [meters.x, meters.y];
  });
  const imageCentroid = centroid(image);
  const targetCentroid = centroid(target);
  let denom = 0;
  let aNum = 0;
  let bNum = 0;
  for (let index = 0; index < image.length; index += 1) {
    const px = image[index][0] - imageCentroid[0];
    const py = image[index][1] - imageCentroid[1];
    const qx = target[index][0] - targetCentroid[0];
    const qy = target[index][1] - targetCentroid[1];
    denom += px * px + py * py;
    aNum += qx * px + qy * py;
    bNum += qy * px - qx * py;
  }
  if (denom === 0) {
    throw new Error("Similarity fit is degenerate");
  }
  const a = aNum / denom;
  const b = bNum / denom;
  const tx = targetCentroid[0] - (a * imageCentroid[0] - b * imageCentroid[1]);
  const ty = targetCentroid[1] - (b * imageCentroid[0] + a * imageCentroid[1]);
  return { type: "similarity", a, b, tx, ty };
}

function fitAffine(points) {
  if (points.length < 3) {
    throw new Error("Affine fit needs at least 3 paired points");
  }
  const rows = points.map((point) => {
    const meters = latLonToMercatorMeters(point.map.lat, point.map.lon);
    return {
      u: point.image.x,
      v: point.image.y,
      x: meters.x,
      y: meters.y,
    };
  });
  const xParams = solveLeastSquares3(rows, "x");
  const yParams = solveLeastSquares3(rows, "y");
  return {
    type: "affine",
    a: xParams[0],
    b: xParams[1],
    tx: xParams[2],
    c: yParams[0],
    d: yParams[1],
    ty: yParams[2],
  };
}

function solveLeastSquares3(rows, outputKey) {
  const normal = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];
  for (const row of rows) {
    const basis = [row.u, row.v, 1];
    for (let i = 0; i < 3; i += 1) {
      rhs[i] += basis[i] * row[outputKey];
      for (let j = 0; j < 3; j += 1) {
        normal[i][j] += basis[i] * basis[j];
      }
    }
  }
  return solveLinearSystem(normal, rhs);
}

function solveLinearSystem(matrix, vector) {
  const a = matrix.map((row, rowIndex) => [...row, vector[rowIndex]]);
  const n = a.length;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-12) {
      throw new Error("Fit is degenerate");
    }
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
    }
    const pivotValue = a[col][col];
    for (let j = col; j <= n; j += 1) {
      a[col][j] /= pivotValue;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) {
        a[row][j] -= factor * a[col][j];
      }
    }
  }
  return a.map((row) => row[n]);
}

function applyFit(fit, u, v) {
  if (fit.type === "axis-aligned") {
    return {
      x: fit.xScale * u + fit.xOffset,
      y: fit.yScale * v + fit.yOffset,
    };
  }
  if (fit.type === "similarity") {
    return {
      x: fit.a * u - fit.b * v + fit.tx,
      y: fit.b * u + fit.a * v + fit.ty,
    };
  }
  return {
    x: fit.a * u + fit.b * v + fit.tx,
    y: fit.c * u + fit.d * v + fit.ty,
  };
}

function applyInverseFit(fit, x, y) {
  if (fit.type === "axis-aligned") {
    if (Math.abs(fit.xScale) < 1e-12 || Math.abs(fit.yScale) < 1e-12) {
      throw new Error("Axis-aligned fit is degenerate");
    }
    return {
      x: (x - fit.xOffset) / fit.xScale,
      y: (y - fit.yOffset) / fit.yScale,
    };
  }
  if (fit.type === "similarity") {
    const denom = fit.a * fit.a + fit.b * fit.b;
    if (Math.abs(denom) < 1e-12) {
      throw new Error("Similarity fit is degenerate");
    }
    const dx = x - fit.tx;
    const dy = y - fit.ty;
    return {
      x: (fit.a * dx + fit.b * dy) / denom,
      y: (-fit.b * dx + fit.a * dy) / denom,
    };
  }
  const det = fit.a * fit.d - fit.b * fit.c;
  if (Math.abs(det) < 1e-12) {
    throw new Error("Affine fit is degenerate");
  }
  const dx = x - fit.tx;
  const dy = y - fit.ty;
  return {
    x: (fit.d * dx - fit.b * dy) / det,
    y: (-fit.c * dx + fit.a * dy) / det,
  };
}

function describeFit(fit) {
  if (fit.type === "axis-aligned") {
    return {
      type: fit.type,
      xMetersPerPixel: roundTo(fit.xScale, 6),
      yMetersPerPixel: roundTo(fit.yScale, 6),
      xOffsetMeters: roundTo(fit.xOffset, 3),
      yOffsetMeters: roundTo(fit.yOffset, 3),
    };
  }
  if (fit.type === "similarity") {
    return {
      type: fit.type,
      scaleMetersPerPixel: roundTo(Math.sqrt(fit.a * fit.a + fit.b * fit.b), 6),
      rotationDegrees: roundTo((Math.atan2(fit.b, fit.a) * 180) / Math.PI, 6),
      a: roundTo(fit.a, 6),
      b: roundTo(fit.b, 6),
      txMeters: roundTo(fit.tx, 3),
      tyMeters: roundTo(fit.ty, 3),
    };
  }
  return {
    type: fit.type,
    a: roundTo(fit.a, 6),
    b: roundTo(fit.b, 6),
    c: roundTo(fit.c, 6),
    d: roundTo(fit.d, 6),
    txMeters: roundTo(fit.tx, 3),
    tyMeters: roundTo(fit.ty, 3),
  };
}

function fitLine(samples) {
  if (samples.length < 2) {
    throw new Error("Need at least 2 samples");
  }
  const inputMean = mean(samples.map((sample) => sample.input));
  const outputMean = mean(samples.map((sample) => sample.output));
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const dx = sample.input - inputMean;
    numerator += dx * (sample.output - outputMean);
    denominator += dx * dx;
  }
  if (denominator === 0) {
    throw new Error("Fit is degenerate");
  }
  const slope = numerator / denominator;
  const intercept = outputMean - slope * inputMean;
  return { slope, intercept };
}

function latLonToMercatorMeters(lat, lon) {
  const latClamped = clamp(lat, -85.05112878, 85.05112878);
  const lonRad = (lon * Math.PI) / 180;
  const latRad = (latClamped * Math.PI) / 180;
  return {
    x: EARTH_RADIUS_METERS * lonRad,
    y: EARTH_RADIUS_METERS * Math.log(Math.tan(Math.PI / 4 + latRad / 2)),
  };
}

function mercatorMetersToLatLon(x, y) {
  const lon = (x / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_METERS)) - Math.PI / 2) * (180 / Math.PI);
  return {
    lat: roundTo(lat, 9),
    lon: roundTo(lon, 9),
  };
}

function centroid(points) {
  const sx = sum(points.map((point) => point[0]));
  const sy = sum(points.map((point) => point[1]));
  return [sx / points.length, sy / points.length];
}

function cornersToBounds(corners) {
  const lats = corners.map((corner) => corner.lat);
  const lons = corners.map((corner) => corner.lon);
  return {
    north: roundTo(Math.max(...lats), 9),
    south: roundTo(Math.min(...lats), 9),
    west: roundTo(Math.min(...lons), 9),
    east: roundTo(Math.max(...lons), 9),
  };
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function sum(values) {
  return values.reduce((accumulator, value) => accumulator + value, 0);
}

function distance2d(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
