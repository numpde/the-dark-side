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
