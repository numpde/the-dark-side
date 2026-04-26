export function createPlannerClient({
  moduleVersion,
  parsePlannerWorkerResponse,
  onUnhandledError = null,
}) {
  if (!moduleVersion) {
    throw new Error("Planner client requires a module version");
  }

  const workerUrl = new URL("./route-worker.js", import.meta.url);
  workerUrl.searchParams.set("v", moduleVersion);
  const worker = new Worker(workerUrl, { type: "module" });

  let nextRequestId = 0;
  const pendingRequests = new Map();
  let workerBooted = false;
  let resolveWorkerBooted;
  let rejectWorkerBooted;
  const workerBootedPromise = new Promise((resolve, reject) => {
    resolveWorkerBooted = resolve;
    rejectWorkerBooted = reject;
  });

  function failWorker(error) {
    rejectWorkerBooted?.(error);
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    onUnhandledError?.(error);
  }

  worker.addEventListener("message", (event) => {
    let message;
    try {
      message = parsePlannerWorkerResponse(event.data);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      failWorker(normalized);
      return;
    }
    const { requestId, type, payload } = message;
    if (type === "booted") {
      workerBooted = true;
      resolveWorkerBooted?.();
      return;
    }
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    if (type === "progress") {
      pending.onProgress?.(payload);
      return;
    }
    pendingRequests.delete(requestId);
    if (type === "error") {
      pending.reject(new Error(payload?.message || "Worker error"));
      return;
    }
    pending.resolve(payload);
  });

  worker.addEventListener("error", (event) => {
    const normalized = event.error || new Error(event.message || "Worker failed");
    failWorker(normalized);
  });

  return {
    async request(type, payload, { onProgress = null } = {}) {
      if (!workerBooted) {
        await workerBootedPromise;
      }
      const requestId = ++nextRequestId;
      return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject, onProgress });
        worker.postMessage({ type, requestId, payload });
      });
    },
  };
}
