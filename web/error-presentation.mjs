
export function formatError(error) {
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

export function showErrorText(errorElement, message) {
  errorElement.textContent = message;
  errorElement.classList.remove("hidden");
}

export function clearErrorText(errorElement) {
  errorElement.textContent = "";
  errorElement.classList.add("hidden");
}

export function renderFailure({ errorElementId, failureLabel, error }) {
  console.error(`Failed to load ${failureLabel}`, error);
  const errorElement = document.getElementById(errorElementId);
  if (!errorElement) {
    return;
  }
  showErrorText(errorElement, `Failed to load ${failureLabel}: ${formatError(error)}`);
}
