import { buildGraphFromGeoJson, planBrowserRoute } from "./route-planner.mjs";

let graph = null;
let plannerConfig = null;

self.addEventListener("message", (event) => {
  const { type, requestId, payload } = event.data || {};

  try {
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
    self.postMessage({
      type: "error",
      requestId,
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
