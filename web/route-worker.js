const MODULE_VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const moduleSuffix = MODULE_VERSION ? `?v=${encodeURIComponent(MODULE_VERSION)}` : "";
let plannerModule = null;
let plannerLoadError = null;
const pendingEvents = [];

let graph = null;
let plannerConfig = null;

function postWorkerError(requestId, error) {
  self.postMessage({
    type: "error",
    requestId,
    payload: {
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function handleMessage(event) {
  const { type, requestId, payload } = event.data || {};

  try {
    if (!plannerModule) {
      throw plannerLoadError || new Error("Route planner is not ready");
    }
    const { buildGraphFromGeoJson, planBrowserRoute } = plannerModule;
    if (type === "init") {
      graph = buildGraphFromGeoJson(payload.network);
      plannerConfig = payload.config;
      self.postMessage({
        type: "ready",
        requestId,
        payload: {
          contigCount: graph.contigs.size,
          nodeCount: graph.nodes.size,
        },
      });
      return;
    }

    if (type === "plan") {
      if (!graph || !plannerConfig) {
        throw new Error("Route worker is not initialized");
      }
      const route = planBrowserRoute(graph, {
        startNodeId: payload.startNodeId,
        endNodeId: payload.endNodeId,
        seed: payload.seed,
        config: plannerConfig,
        routeId: payload.routeId,
      });
      self.postMessage({
        type: "planned",
        requestId,
        payload: route,
      });
      return;
    }

    throw new Error(`Unknown worker message: ${type}`);
  } catch (error) {
    postWorkerError(requestId, error);
  }
}

self.addEventListener("message", (event) => {
  if (!plannerModule && !plannerLoadError) {
    pendingEvents.push(event);
    return;
  }
  handleMessage(event);
});

(async () => {
  try {
    plannerModule = await import(`./route-planner.mjs${moduleSuffix}`);
    while (pendingEvents.length) {
      handleMessage(pendingEvents.shift());
    }
  } catch (error) {
    plannerLoadError = error instanceof Error ? error : new Error(String(error));
    while (pendingEvents.length) {
      const event = pendingEvents.shift();
      const { requestId } = event.data || {};
      postWorkerError(requestId, plannerLoadError);
    }
  }
})();
