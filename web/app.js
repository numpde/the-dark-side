function requireModuleVersion() {
  const version = new URL(import.meta.url).searchParams.get("v");
  if (!version) {
    throw new Error("App runtime is missing required module version");
  }
  return version;
}

const MODULE_VERSION = requireModuleVersion();
const moduleSuffix = `?v=${encodeURIComponent(MODULE_VERSION)}`;
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
