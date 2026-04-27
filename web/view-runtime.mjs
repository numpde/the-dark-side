const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "View runtime module");
const { showErrorText } = await import(`./error-presentation.mjs${moduleSuffix}`);

function findErrorElement(errorElementId) {
  return document.getElementById(errorElementId);
}

export function requireElement(id, { errorElementId = null } = {}) {
  const element = document.getElementById(id);
  if (element) {
    return element;
  }
  const message = `Missing required page element: #${id}`;
  if (errorElementId) {
    const errorElement = findErrorElement(errorElementId);
    if (errorElement) {
      showErrorText(errorElement, message);
    }
  }
  console.error(message);
  throw new Error(message);
}

export function guard(reportError, context, fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      reportError(error, context);
      return undefined;
    }
  };
}

export function guardAsync(reportError, context, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      reportError(error, context);
      return undefined;
    }
  };
}
