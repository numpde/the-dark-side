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

  function rejectPendingRequests(error) {
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
  }

  worker.addEventListener("message", (event) => {
    let message;
    try {
      message = parsePlannerWorkerResponse(event.data);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      rejectPendingRequests(normalized);
      onUnhandledError?.(normalized);
      return;
    }
    const { requestId, type, payload } = message;
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
    rejectPendingRequests(normalized);
    onUnhandledError?.(normalized);
  });

  return {
    request(type, payload, { onProgress = null } = {}) {
      const requestId = ++nextRequestId;
      return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject, onProgress });
        worker.postMessage({ type, requestId, payload });
      });
    },
  };
}
