export function requireVersionedModuleContext(importMeta, label) {
  const version = new URL(importMeta.url).searchParams.get("v");
  if (!version) {
    throw new Error(`${label} is missing required module version`);
  }
  return {
    moduleVersion: version,
    moduleSuffix: `?v=${encodeURIComponent(version)}`,
  };
}
