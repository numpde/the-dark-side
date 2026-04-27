const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Editor runtime");
const { createEditorController } = await import(`./editor-controller.mjs${moduleSuffix}`);
const { formatError, showErrorText } = await import(`./error-presentation.mjs${moduleSuffix}`);

function findErrorBox() {
  return document.getElementById("error-box");
}

function reportFatalError(error, context = "Editor error") {
  const message = `${context}: ${formatError(error)}`;
  console.error(message, error);
  const box = findErrorBox();
  if (box) {
    showErrorText(box, message);
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
