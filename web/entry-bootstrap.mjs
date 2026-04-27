function requireManifestModuleVersion(manifest, key) {
  const value = manifest?.modules?.[key];
  if (!value) {
    throw new Error(`Frontend manifest is missing modules.${key}`);
  }
  return value;
}

export async function bootVersionedEntry({
  manifest,
  bootstrapVersionKey,
  entryVersionKey,
  entryPath,
}) {
  requireManifestModuleVersion(manifest, bootstrapVersionKey);
  const entryVersion = requireManifestModuleVersion(manifest, entryVersionKey);
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
