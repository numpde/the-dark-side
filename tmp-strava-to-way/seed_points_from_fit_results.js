#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const STORAGE_KEY = "strava-fit-editor-v1";
const EARTH_RADIUS_METERS = 6378137;
const DEFAULT_FIGURE_STATE = {
  nextPointNumber: 1,
  selectedPointId: null,
  points: [],
  lastFit: null,
};
const SEED_FRACTIONS = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.75, 0.75],
  [0.25, 0.75],
  [0.5, 0.5],
];

async function main() {
  const workdir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const cdpUrl = process.argv[3] ?? "http://127.0.0.1:9333";
  const dataset = JSON.parse(fs.readFileSync(path.join(workdir, "generated/strava-fit-dataset.json"), "utf8"));
  const figuresById = Object.fromEntries(dataset.figures.map((figure) => [figure.id, figure]));
  const fitFiles = fs
    .readdirSync(workdir)
    .filter((name) => /^fit-\d+\.txt$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    const page = context?.pages().find((entry) => entry.url().startsWith("http://127.0.0.1:8776/"));
    if (!page) {
      throw new Error("Editor page not found in shared Chromium session");
    }

    const originalRaw = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
    if (!originalRaw) {
      throw new Error("No editor state found in localStorage");
    }
    const state = JSON.parse(originalRaw);

    const backupPath = path.join(
      workdir,
      `localstorage-backup-before-point-seed-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    fs.writeFileSync(backupPath, JSON.stringify(state, null, 2));

    const seeded = [];
    const skipped = [];
    for (const fitFile of fitFiles) {
      const fit = JSON.parse(fs.readFileSync(path.join(workdir, fitFile), "utf8"));
      const figure = figuresById[fit.figureId];
      if (!figure) {
        skipped.push({ fitFile, reason: "missing figure in dataset" });
        continue;
      }
      const figureState = normalizeFigureState(state.figures[fit.figureId]);
      if (figureState.points.length > 0) {
        skipped.push({ fitFile, figureId: fit.figureId, reason: `already has ${figureState.points.length} point(s)` });
        state.figures[fit.figureId] = figureState;
        continue;
      }
      figureState.points = buildSeedPoints(figure, fit.transform);
      figureState.nextPointNumber = figureState.points.length + 1;
      figureState.selectedPointId = figureState.points.at(-1)?.id ?? null;
      state.figures[fit.figureId] = figureState;
      seeded.push({ fitFile, figureId: fit.figureId, pointCount: figureState.points.length });
    }

    await page.evaluate(
      ({ key, raw }) => window.localStorage.setItem(key, raw),
      { key: STORAGE_KEY, raw: JSON.stringify(state) }
    );
    await page.reload({ waitUntil: "domcontentloaded" });

    console.log(JSON.stringify({ backupPath, seeded, skipped }, null, 2));
  } finally {
    await browser.close();
  }
}

function buildSeedPoints(figure, transform) {
  return SEED_FRACTIONS.map(([xFraction, yFraction], index) => {
    const imageX = roundTo(figure.imageSize.width * xFraction, 2);
    const imageY = roundTo(figure.imageSize.height * yFraction, 2);
    const meters = applyTransform(transform, imageX, imageY);
    const latLon = mercatorMetersToLatLon(meters.x, meters.y);
    return {
      id: index + 1,
      image: {
        x: imageX,
        y: imageY,
      },
      map: {
        lat: roundTo(latLon.lat, 7),
        lon: roundTo(latLon.lon, 7),
      },
    };
  });
}

function applyTransform(transform, imageX, imageY) {
  if (transform.type === "axis-aligned") {
    return {
      x: transform.xMetersPerPixel * imageX + transform.xOffsetMeters,
      y: transform.yMetersPerPixel * imageY + transform.yOffsetMeters,
    };
  }
  if (transform.type === "similarity") {
    return {
      x: transform.a * imageX - transform.b * imageY + transform.txMeters,
      y: transform.b * imageX + transform.a * imageY + transform.tyMeters,
    };
  }
  return {
    x: transform.a * imageX + transform.b * imageY + transform.txMeters,
    y: transform.c * imageX + transform.d * imageY + transform.tyMeters,
  };
}

function mercatorMetersToLatLon(x, y) {
  return {
    lon: (x / EARTH_RADIUS_METERS) * (180 / Math.PI),
    lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS_METERS)) - Math.PI / 2) * (180 / Math.PI),
  };
}

function normalizeFigureState(figureState) {
  return {
    ...DEFAULT_FIGURE_STATE,
    ...(figureState || {}),
    points: Array.isArray(figureState?.points) ? figureState.points : [],
  };
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
