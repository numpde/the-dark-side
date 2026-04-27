const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Editor runtime");
const { createEditorController } = await import(`./editor-controller.mjs${moduleSuffix}`);
const { createFatalErrorReporter, installWindowErrorHandlers } = await import(`./fatal-error-runtime.mjs${moduleSuffix}`);

const reportFatalError = createFatalErrorReporter({
  errorElementId: "error-box",
  defaultContext: "Editor error",
});
installWindowErrorHandlers(reportFatalError);

const controller = createEditorController({
  editorManifestUrl: new URL("./generated/editor-manifest.json", window.location.href),
  reportError: reportFatalError,
});

controller.boot().catch((error) => {
  reportFatalError(error, "Failed to load editor");
});
