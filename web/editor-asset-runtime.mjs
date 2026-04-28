const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
requireVersionedModuleContext(import.meta, "Editor asset runtime module");

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return await response.json();
}

function canonicalRoutePolicyFilename(path) {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  if (!filename) {
    throw new Error(`Editor manifest has invalid meta.route_policy_path: ${path}`);
  }
  return filename;
}

export function buildEditorAssetUrls(editorManifest, editorManifestUrl, pageUrl = window.location.href) {
  const waysUrl = new URL(editorManifest.editor.network_path, editorManifestUrl);
  waysUrl.searchParams.set("v", editorManifest.editor.network_version);

  const routePolicyPath = editorManifest.meta.route_policy_path;
  const routePolicyUrl = new URL(`./${routePolicyPath}`, pageUrl);
  routePolicyUrl.searchParams.set("v", editorManifest.meta.route_policy_digest);

  return {
    routePolicyPath,
    routePolicyFilename: canonicalRoutePolicyFilename(routePolicyPath),
    waysUrl,
    routePolicyUrl,
  };
}

export async function loadEditorBundle({ editorManifestUrl, validateEditorManifest, pageUrl }) {
  const editorManifest = validateEditorManifest(
    await fetchJson(editorManifestUrl, { cache: "no-store" }),
  );
  const assetUrls = buildEditorAssetUrls(editorManifest, editorManifestUrl, pageUrl);
  const [waysGeojson, routePolicy] = await Promise.all([
    fetchJson(assetUrls.waysUrl),
    fetchJson(assetUrls.routePolicyUrl),
  ]);
  return {
    editorManifest,
    assetUrls,
    waysGeojson,
    routePolicy,
  };
}

export async function readJsonFile(file) {
  return JSON.parse(await file.text());
}

export function downloadJsonDocument(payload, filename) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
