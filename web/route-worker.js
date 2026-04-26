const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route worker");
let plannerModule = null;
let workerContracts = null;
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

function postWorkerProgress(requestId, payload) {
  self.postMessage({
    type: "progress",
    requestId,
    payload,
  });
}

function handleMessage(event) {
  let message;
  try {
    message = workerContracts.parsePlannerWorkerRequest(event.data);
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
      const { network, config } = workerContracts.validatePlannerWorkerInitPayload(payload);
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
      const {
        routeId,
        startNodeId,
        endNodeId,
        seed,
        recentRouteContigSequences,
      } = workerContracts.validatePlannerWorkerPlanPayload(payload);
      const route = planBrowserRoute(graph, {
        startNodeId,
        endNodeId,
        seed,
        config: plannerConfig,
        routeId,
        recentRouteContigSequences,
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
  if ((!plannerModule || !workerContracts) && !plannerLoadError) {
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
    [workerContracts, plannerModule] = await Promise.all([
      import(`./planner-worker-contracts.mjs${moduleSuffix}`),
      import(`./route-planner.mjs${moduleSuffix}`),
    ]);
    self.postMessage({
      type: "booted",
      requestId: 0,
      payload: {},
    });
    while (pendingEvents.length) {
      handleMessage(pendingEvents.shift());
    }
  } catch (error) {
    plannerLoadError = error instanceof Error ? error : new Error(String(error));
    while (pendingEvents.length) {
      const event = pendingEvents.shift();
      try {
        const { requestId } = workerContracts
          ? workerContracts.parsePlannerWorkerRequest(event.data)
          : { requestId: undefined };
        postWorkerError(requestId, plannerLoadError);
      } catch {
        postWorkerError(undefined, plannerLoadError);
      }
    }
  }
})();
