import { formatError, showErrorText } from "./error-presentation.mjs";

function findErrorElement(errorElementId) {
  return document.getElementById(errorElementId);
}

export function createFatalErrorReporter({
  errorElementId,
  defaultContext = "Runtime error",
}) {
  return function reportFatalError(error, context = defaultContext) {
    const message = `${context}: ${formatError(error)}`;
    console.error(message, error);
    const errorElement = findErrorElement(errorElementId);
    if (errorElement) {
      showErrorText(errorElement, message);
    }
  };
}

export function installWindowErrorHandlers(reportFatalError) {
  window.addEventListener("error", (event) => {
    reportFatalError(event.error ?? event.message, "Page error");
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportFatalError(event.reason, "Unhandled promise rejection");
  });
}
