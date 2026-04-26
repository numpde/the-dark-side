const MODULE_VERSION = new URL(import.meta.url).searchParams.get("v");
const moduleSuffix = MODULE_VERSION ? `?v=${encodeURIComponent(MODULE_VERSION)}` : "";
let plannerModule = null;
let plannerLoadError = MODULE_VERSION
  ? null
  : new Error("Route worker is missing required module version");
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

function postWorkerProgress(requestId, payload) {
  self.postMessage({
    type: "progress",
    requestId,
    payload,
  });
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function requireRouteHistory(value, label) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => !Array.isArray(item))) {
    throw new Error(`${label} must be an array of contig-id sequences`);
  }
  return value;
}

function parseWorkerRequest(event) {
  const data = requireObject(event.data, "Worker request");
  const type = requireString(data.type, "Worker request type");
  const requestId = requireInteger(data.requestId, "Worker request requestId");
  const payload = requireObject(data.payload, "Worker request payload");
  return { type, requestId, payload };
}

function handleMessage(event) {
  let message;
  try {
    message = parseWorkerRequest(event);
  } catch (error) {
    postWorkerError(undefined, error);
    return;
  }
  const { type, requestId, payload } = message;

  try {
    if (!plannerModule) {
      throw plannerLoadError || new Error("Route planner is not ready");
    }
    const { buildGraphFromGeoJson, planBrowserRoute } = plannerModule;
    if (type === "init") {
      const network = requireObject(payload.network, "Route worker init payload.network");
      const config = requireObject(payload.config, "Route worker init payload.config");
      graph = buildGraphFromGeoJson(network);
      plannerConfig = config;
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
      const routeId = requireString(payload.routeId, "Route worker plan payload.routeId");
      const startNodeId = requireInteger(payload.startNodeId, "Route worker plan payload.startNodeId");
      const endNodeId = requireInteger(payload.endNodeId, "Route worker plan payload.endNodeId");
      const seed = requireInteger(payload.seed, "Route worker plan payload.seed");
      const route = planBrowserRoute(graph, {
        startNodeId,
        endNodeId,
        seed,
        config: plannerConfig,
        routeId,
        recentRouteContigSequences: requireRouteHistory(
          payload.recentRouteContigSequences,
          "Route worker plan payload.recentRouteContigSequences",
        ),
        onProgress: (partialRoute) => {
          postWorkerProgress(requestId, partialRoute);
        },
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
    if (plannerLoadError) {
      throw plannerLoadError;
    }
    plannerModule = await import(`./route-planner.mjs${moduleSuffix}`);
    while (pendingEvents.length) {
      handleMessage(pendingEvents.shift());
    }
  } catch (error) {
    plannerLoadError = error instanceof Error ? error : new Error(String(error));
    while (pendingEvents.length) {
      const event = pendingEvents.shift();
      try {
        const { requestId } = parseWorkerRequest(event);
        postWorkerError(requestId, plannerLoadError);
      } catch {
        postWorkerError(undefined, plannerLoadError);
      }
    }
  }
})();
