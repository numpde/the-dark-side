import { createEditorController } from "./editor-controller.mjs";
import { createFatalErrorReporter, installWindowErrorHandlers } from "./fatal-error-runtime.mjs";

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
