import { createPlannerClient } from "./planner-client.mjs";

export function createRouteRuntime({
  moduleVersion,
  parsePlannerWorkerResponse,
  onUnhandledError = null,
  initialSeed = Math.floor(Math.random() * 1_000_000),
}) {
  let plannerClient = null;
  let plannerReady = false;
  let routeSeedCounter = initialSeed;

  function ensurePlannerClient() {
    if (plannerClient) {
      return plannerClient;
    }
    plannerClient = createPlannerClient({
      moduleVersion,
      parsePlannerWorkerResponse,
      onUnhandledError,
    });
    return plannerClient;
  }

  async function sendWorkerMessage(type, payload, { onProgress = null } = {}) {
    return ensurePlannerClient().request(type, payload, { onProgress });
  }

  return {
    get plannerReady() {
      return plannerReady;
    },

    nextRouteSeed() {
      routeSeedCounter += 1;
      return routeSeedCounter;
    },

    async initializePlanner(networkPayload, config) {
      plannerReady = false;
      await sendWorkerMessage("init", {
        network: networkPayload,
        config,
      });
      plannerReady = true;
    },

    async requestRoute(planPayload, options) {
      return sendWorkerMessage("plan", planPayload, options);
    },
  };
}
