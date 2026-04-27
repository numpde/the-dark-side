const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Editor runtime");
const { createEditorController } = await import(`./editor-controller.mjs${moduleSuffix}`);

function findErrorBox() {
  return document.getElementById("error-box");
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function reportFatalError(error, context = "Editor error") {
  const message = `${context}: ${formatError(error)}`;
  console.error(message, error);
  const box = findErrorBox();
  if (box) {
    box.textContent = message;
    box.classList.remove("hidden");
  }
}

window.addEventListener("error", (event) => {
  reportFatalError(event.error ?? event.message, "Page error");
});

window.addEventListener("unhandledrejection", (event) => {
  reportFatalError(event.reason, "Unhandled promise rejection");
});

const controller = createEditorController({
  editorManifestUrl: new URL("./generated/editor-manifest.json", window.location.href),
  reportError: reportFatalError,
});

controller.boot().catch((error) => {
  reportFatalError(error, "Failed to load editor");
});
