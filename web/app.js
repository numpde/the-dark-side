const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "App runtime");
const { createRouteController } = await import(`./route-controller.mjs${moduleSuffix}`);

const appManifestUrl = new URL("./generated/app-manifest.json", window.location.href);

createRouteController({
  appManifestUrl,
  loopArrowIntervalMs: 1000,
  elements: {
    areaSelect: document.getElementById("area-select"),
    startSelect: document.getElementById("start-select"),
    endSelect: document.getElementById("end-select"),
    scenarioLabel: document.getElementById("scenario-label"),
    errorCard: document.getElementById("error-card"),
    newRouteButton: document.getElementById("new-route-button"),
    downloadLink: document.getElementById("download-link"),
    routeStrip: document.querySelector(".route-strip"),
    buttonRow: document.querySelector(".button-row"),
    mapElement: document.getElementById("map"),
  },
}).boot();
