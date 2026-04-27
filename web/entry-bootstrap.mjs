const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Entry bootstrap module");
const { renderFailure } = await import(`./error-presentation.mjs${moduleSuffix}`);

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

export async function bootPageEntry({
  manifest,
  errorElementId,
  failureLabel,
  bootstrapVersionKey,
  entryVersionKey,
  entryPath,
}) {
  try {
    await bootVersionedEntry({
      manifest,
      bootstrapVersionKey,
      entryVersionKey,
      entryPath,
    });
  } catch (error) {
    renderFailure({
      errorElementId,
      failureLabel,
      error,
    });
  }
}

export { renderFailure as renderBootstrapFailure };
