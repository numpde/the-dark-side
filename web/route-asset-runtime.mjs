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

export function buildAreaNetworkUrl(appManifestUrl, appManifest, area) {
  const url = new URL(area.network_path ?? appManifest.planner.network_path, appManifestUrl);
  url.searchParams.set("v", area.network_version ?? appManifest.planner.network_version);
  return url;
}

export function buildAreaBackgroundNetworkUrl(appManifestUrl, appManifest, area) {
  const url = new URL(area.background_network_path ?? appManifest.planner.background_network_path, appManifestUrl);
  url.searchParams.set("v", area.background_network_version ?? appManifest.planner.background_network_version);
  return url;
}

export async function loadAreaNetwork(appManifestUrl, appManifest, area) {
  return fetchJson(buildAreaNetworkUrl(appManifestUrl, appManifest, area), { cache: "default" });
}

export async function loadAreaAssets(appManifestUrl, appManifest, area) {
  const [plannerNetwork, backgroundNetwork] = await Promise.all([
    loadAreaNetwork(appManifestUrl, appManifest, area),
    fetchJson(buildAreaBackgroundNetworkUrl(appManifestUrl, appManifest, area), { cache: "default" }),
  ]);
  return {
    plannerNetwork,
    backgroundNetwork,
  };
}
