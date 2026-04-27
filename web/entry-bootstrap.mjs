export async function bootVersionedEntry({
  manifestUrl,
  bootstrapVersionKey,
  entryVersionKey,
  entryPath,
}) {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load frontend manifest: ${response.status}`);
  }
  const manifest = await response.json();
  const bootstrapVersion = manifest?.modules?.[bootstrapVersionKey];
  if (!bootstrapVersion) {
    throw new Error(`Frontend manifest is missing modules.${bootstrapVersionKey}`);
  }
  const entryVersion = manifest?.modules?.[entryVersionKey];
  if (!entryVersion) {
    throw new Error(`Frontend manifest is missing modules.${entryVersionKey}`);
  }
  const specifier = `${entryPath}?v=${encodeURIComponent(entryVersion)}`;
  await import(specifier);
}

export function renderBootstrapFailure({ errorElementId, failureLabel, error }) {
  console.error(`Failed to load ${failureLabel}`, error);
  const errorElement = document.getElementById(errorElementId);
  if (!errorElement) {
    return;
  }
  errorElement.textContent = `Failed to load ${failureLabel}: ${error.message || String(error)}`;
  errorElement.classList.remove("hidden");
}
