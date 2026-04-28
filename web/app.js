import { createRouteController } from "./route-controller.mjs";
import { createFatalErrorReporter, installWindowErrorHandlers } from "./fatal-error-runtime.mjs";

const appManifestUrl = new URL("./generated/app-manifest.json", window.location.href);

const reportFatalError = createFatalErrorReporter({
  errorElementId: "error-card",
  defaultContext: "App error",
});
installWindowErrorHandlers(reportFatalError);

const controller = createRouteController({
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
});

controller.boot().catch((error) => {
  reportFatalError(error, "Failed to load routes");
});
