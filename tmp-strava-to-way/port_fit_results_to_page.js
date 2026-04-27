#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const STORAGE_KEY = "strava-fit-editor-v1";
const DEFAULT_UI = {
  figureId: null,
  fitMode: "axis-aligned",
  showRegion: true,
  showBounds: true,
};
const DEFAULT_FIGURE_STATE = {
  nextPointNumber: 1,
  selectedPointId: null,
  points: [],
  lastFit: null,
};

async function main() {
  const workdir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const cdpUrl = process.argv[3] ?? "http://127.0.0.1:9333";
  const fitFiles = fs
    .readdirSync(workdir)
    .filter((name) => /^fit-\d+\.txt$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  if (!fitFiles.length) {
    throw new Error(`No fit-*.txt files found in ${workdir}`);
  }

  const fitResults = fitFiles.map((name) => {
    const raw = fs.readFileSync(path.join(workdir, name), "utf8");
    const output = JSON.parse(raw);
    return {
      fileName: name,
      figureId: output.figureId,
      fitState: {
        polygonLatLngs: output.corners.map((corner) => [corner.lat, corner.lon]),
        output,
      },
    };
  });

  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    const page = context?.pages().find((entry) => entry.url().startsWith("http://127.0.0.1:8776/"));
    if (!page) {
      throw new Error("Editor page not found in shared Chromium session");
    }

    const originalRaw = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
    const originalState = originalRaw ? JSON.parse(originalRaw) : { ui: { ...DEFAULT_UI }, figures: {} };

    const backupPath = path.join(
      workdir,
      `localstorage-backup-before-fit-port-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    fs.writeFileSync(backupPath, JSON.stringify(originalState, null, 2));

    const nextState = {
      ui: { ...DEFAULT_UI, ...(originalState.ui || {}) },
      figures: { ...(originalState.figures || {}) },
    };

    for (const fitResult of fitResults) {
      const figureState = normalizeFigureState(nextState.figures[fitResult.figureId]);
      if (!figureState.points.length && Array.isArray(fitResult.fitState.output.controlPoints)) {
        figureState.points = fitResult.fitState.output.controlPoints.map((point) => ({
          id: point.pointId,
          image: {
            x: point.image.x,
            y: point.image.y,
          },
          map: {
            lat: point.map.lat,
            lon: point.map.lon,
          },
        }));
        figureState.nextPointNumber = Math.max(1, ...figureState.points.map((point) => point.id)) + 1;
        figureState.selectedPointId = figureState.points.at(-1)?.id ?? null;
      }
      figureState.lastFit = fitResult.fitState;
      nextState.figures[fitResult.figureId] = figureState;
    }

    await page.evaluate(
      ({ key, raw }) => window.localStorage.setItem(key, raw),
      { key: STORAGE_KEY, raw: JSON.stringify(nextState) }
    );
    await page.reload({ waitUntil: "domcontentloaded" });

    const summary = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      const state = raw ? JSON.parse(raw) : null;
      return Object.fromEntries(
        Object.entries(state?.figures || {}).map(([figureId, figureState]) => [
          figureId,
          {
            pointCount: Array.isArray(figureState.points) ? figureState.points.length : 0,
            selectedPointId: figureState.selectedPointId ?? null,
            hasLastFit: !!figureState.lastFit,
            controlPointCount: figureState.lastFit?.output?.controlPointCount ?? null,
          },
        ])
      );
    }, STORAGE_KEY);

    console.log(
      JSON.stringify(
        {
          importedFiles: fitFiles,
          backupPath,
          summary,
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
}

function normalizeFigureState(figureState) {
  return {
    ...DEFAULT_FIGURE_STATE,
    ...(figureState || {}),
    points: Array.isArray(figureState?.points) ? figureState.points : [],
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
