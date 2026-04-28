import { validateAppManifest } from "./runtime-contracts.mjs";

async function fetchJson(url, { cache = "no-store" } = {}) {
  const response = await fetch(url, { cache });
  if (!response.ok) {
    throw new Error(`Failed to load ${url.pathname.split("/").pop()}: ${response.status}`);
  }
  return response.json();
}

export async function loadAppManifest(appManifestUrl) {
  return validateAppManifest(await fetchJson(appManifestUrl));
}

export function buildAreaNetworkUrl(appManifestUrl, appManifest) {
  const url = new URL(appManifest.planner.network_path, appManifestUrl);
  url.searchParams.set("v", appManifest.planner.network_version);
  return url;
}

export function buildAreaBackgroundNetworkUrl(appManifestUrl, appManifest) {
  const url = new URL(appManifest.planner.background_network_path, appManifestUrl);
  url.searchParams.set("v", appManifest.planner.background_network_version);
  return url;
}

export async function loadAreaNetwork(appManifestUrl, appManifest) {
  return fetchJson(buildAreaNetworkUrl(appManifestUrl, appManifest), { cache: "default" });
}

export async function loadAreaAssets(appManifestUrl, appManifest) {
  const [plannerNetwork, backgroundNetwork] = await Promise.all([
    loadAreaNetwork(appManifestUrl, appManifest),
    fetchJson(buildAreaBackgroundNetworkUrl(appManifestUrl, appManifest), { cache: "default" }),
  ]);
  return {
    plannerNetwork,
    backgroundNetwork,
  };
}
