const catalogUrl = new URL("./generated/catalog.json", window.location.href);
const networkUrls = {
  karura: new URL("./generated/karura-network.geojson", window.location.href),
};

const areaSelect = document.getElementById("area-select");
const startSelect = document.getElementById("start-select");
const endSelect = document.getElementById("end-select");
const scenarioLabel = document.getElementById("scenario-label");
const errorCard = document.getElementById("error-card");
const newRouteButton = document.getElementById("new-route-button");
const downloadLink = document.getElementById("download-link");
const LOOP_ARROW_INTERVAL_MS = 1000;

let appState = {
  catalog: null,
  area: null,
  network: null,
  route: null,
  map: null,
  networkLayer: null,
  routeLayer: null,
  markerLayer: null,
  gpxUrl: null,
  loopArrowPhase: 0,
};


function cloneProfile(profile) {
  return Array.isArray(profile) ? profile.map(([distance, elevation]) => [distance, elevation]) : [];
}


function reverseProfile(profile) {
  if (!Array.isArray(profile) || !profile.length) {
    return [];
  }
  const totalDistance = profile[profile.length - 1][0];
  return [...profile]
    .reverse()
    .map(([distance, elevation]) => [
      Math.round((totalDistance - distance) * 1000) / 1000,
      elevation,
    ]);
}


function buildRouteFamilyIndex(area) {
  const index = {};
  for (const family of area.route_families || []) {
    index[family.id] = family;
  }
  area.routeFamilyIndex = index;
}


function showError(message) {
  errorCard.textContent = message;
  errorCard.classList.remove("hidden");
}


function clearError() {
  errorCard.textContent = "";
  errorCard.classList.add("hidden");
}


function formatDistance(lengthM) {
  return `${(lengthM / 1000).toFixed(2)} km`;
}


function formatElevationChange(lengthM) {
  return `${lengthM.toFixed(0)} m`;
}


function animatedLoopArrow() {
  return appState.loopArrowPhase % 2 === 0 ? "↗" : "↘";
}


function mixColor(start, end, fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const values = start.map((value, index) =>
    Math.round(value + (end[index] - value) * clamped)
  );
  return `rgb(${values[0]}, ${values[1]}, ${values[2]})`;
}


function boundsToLeaflet(bounds) {
  return [
    [bounds[1], bounds[0]],
    [bounds[3], bounds[2]],
  ];
}


function buildGpx(route, startJunction, endJunction) {
  const hasElevations =
    Array.isArray(route.elevations_m) &&
    route.elevations_m.length === route.coordinates.length;
  const trackPoints = route.coordinates
    .map(([lon, lat], index) => {
      if (!hasElevations) {
        return `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`;
      }
      return [
        `      <trkpt lat="${lat}" lon="${lon}">`,
        `        <ele>${route.elevations_m[index].toFixed(1)}</ele>`,
        "      </trkpt>",
      ].join("\n");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="karura-route-drop" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${route.id}</name>
  </metadata>
  <trk>
    <name>${startJunction.name} to ${endJunction.name}</name>
    <trkseg>
${trackPoints}
    </trkseg>
  </trk>
</gpx>
`;
}


function scenarioId(startJunctionId, endJunctionId) {
  return `${startJunctionId}__to__${endJunctionId}`;
}


function scenarioLabelText(scenario, area) {
  const start = area.junctions.find((item) => item.id === scenario.start_junction_id);
  const end = area.junctions.find((item) => item.id === scenario.end_junction_id);
  if (!start || !end) {
    return scenario.id;
  }
  if (scenario.is_loop) {
    return `${start.name} loop`;
  }
  return `${start.name} to ${end.name}`;
}


function randomRoute(routes, previousRouteId) {
  if (!routes.length) {
    return null;
  }
  if (routes.length === 1) {
    return routes[0];
  }
  let next = routes[Math.floor(Math.random() * routes.length)];
  while (next.id === previousRouteId) {
    next = routes[Math.floor(Math.random() * routes.length)];
  }
  return next;
}


function materializeRoute(routeRef, area) {
  const family = area.routeFamilyIndex?.[routeRef.family_id];
  if (!family) {
    throw new Error(`Missing route family: ${routeRef.family_id}`);
  }

  const route = {
    ...family,
    id: routeRef.id,
    family_id: routeRef.family_id,
    direction: routeRef.direction,
    algorithm: routeRef.algorithm,
    seed: routeRef.seed,
    candidate_rank: routeRef.candidate_rank,
    quality_score: routeRef.quality_score,
    coordinates: family.coordinates.map(([lon, lat]) => [lon, lat]),
    elevations_m: Array.isArray(family.elevations_m) ? [...family.elevations_m] : undefined,
    elevation_profile: cloneProfile(family.elevation_profile),
    repeated_contig_ids: Array.isArray(family.repeated_contig_ids) ? [...family.repeated_contig_ids] : [],
  };

  if (routeRef.direction === "reverse") {
    route.coordinates.reverse();
    if (Array.isArray(route.elevations_m)) {
      route.elevations_m.reverse();
    }
    route.elevation_profile = reverseProfile(family.elevation_profile);
    const gain = route.elevation_gain_m;
    route.elevation_gain_m = route.elevation_loss_m;
    route.elevation_loss_m = gain;
  }

  return route;
}


function currentScenario() {
  if (!appState.area) {
    return null;
  }
  return appState.area.scenarios.find(
    (item) =>
      item.id === scenarioId(startSelect.value, endSelect.value)
  );
}


function ensureMap() {
  if (appState.map) {
    return appState.map;
  }
  const map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  });
  map.setView([-1.2418, 36.8315], 14);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
  appState.map = map;
  return map;
}


function renderNetwork() {
  const map = ensureMap();
  if (appState.networkLayer) {
    appState.networkLayer.remove();
  }
  if (!appState.network) {
    return;
  }
  appState.networkLayer = L.geoJSON(appState.network, {
    style: {
      color: "#3d4f46",
      weight: 2,
      opacity: 0.33,
    },
  }).addTo(map);
}


function renderRoute() {
  const map = ensureMap();
  if (appState.routeLayer) {
    appState.routeLayer.remove();
  }
  if (appState.markerLayer) {
    appState.markerLayer.remove();
  }

  const route = appState.route;
  const scenario = currentScenario();
  if (!route || !scenario) {
    return;
  }

  const routeLayer = L.layerGroup();
  const startColor = [36, 96, 220];
  const endColor = [230, 40, 40];
  const totalSegments = Math.max(1, route.coordinates.length - 1);

  route.coordinates.forEach((_, index) => {
    if (index === route.coordinates.length - 1) {
      return;
    }
    const first = route.coordinates[index];
    const second = route.coordinates[index + 1];
    const fraction = index / totalSegments;
    L.polyline(
      [
        [first[1], first[0]],
        [second[1], second[0]],
      ],
      {
        color: mixColor(startColor, endColor, fraction),
        weight: 6,
        opacity: 0.92,
        lineCap: "round",
      }
    ).addTo(routeLayer);
  });

  const markerLayer = L.layerGroup();
  const startJunction = appState.area.junctions.find((item) => item.id === scenario.start_junction_id);
  const endJunction = appState.area.junctions.find((item) => item.id === scenario.end_junction_id);
  L.circleMarker([startJunction.lat, startJunction.lon], {
    radius: 7,
    color: "#ffffff",
    weight: 3,
    fillColor: "#2d8c4d",
    fillOpacity: 1,
  }).bindTooltip(`Start: ${startJunction.name}`, { direction: "top" }).addTo(markerLayer);
  L.circleMarker([endJunction.lat, endJunction.lon], {
    radius: 7,
    color: "#ffffff",
    weight: 3,
    fillColor: "#245ac9",
    fillOpacity: 1,
  }).bindTooltip(`End: ${endJunction.name}`, { direction: "top" }).addTo(markerLayer);

  routeLayer.addTo(map);
  markerLayer.addTo(map);
  appState.routeLayer = routeLayer;
  appState.markerLayer = markerLayer;
  map.fitBounds(boundsToLeaflet(route.bounds), {
    padding: [28, 28],
    maxZoom: 16,
  });
}


function updateRouteStats() {
  const route = appState.route;
  const scenario = currentScenario();
  if (!route || !scenario) {
    return;
  }
  const hasGain = typeof route.elevation_gain_m === "number";
  const hasLoss = typeof route.elevation_loss_m === "number";
  let summaryText = `${scenarioLabelText(scenario, appState.area)}, ${formatDistance(route.unique_length_m)}`;
  if (scenario.is_loop && hasGain && hasLoss) {
    const averageChange = (route.elevation_gain_m + route.elevation_loss_m) / 2;
    summaryText += ` (${animatedLoopArrow()} ${formatElevationChange(averageChange)})`;
  } else if (hasGain || hasLoss) {
    const upText = hasGain ? formatElevationChange(route.elevation_gain_m) : "—";
    const downText = hasLoss ? formatElevationChange(route.elevation_loss_m) : "—";
    summaryText += ` (↗ ${upText}, ↘ ${downText})`;
  }
  scenarioLabel.textContent = summaryText;
}


function updateDownloadLink() {
  const route = appState.route;
  const scenario = currentScenario();
  if (!route || !scenario) {
    return;
  }

  const startJunction = appState.area.junctions.find((item) => item.id === scenario.start_junction_id);
  const endJunction = appState.area.junctions.find((item) => item.id === scenario.end_junction_id);
  const gpx = buildGpx(route, startJunction, endJunction);
  if (appState.gpxUrl) {
    URL.revokeObjectURL(appState.gpxUrl);
  }
  appState.gpxUrl = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
  downloadLink.href = appState.gpxUrl;
  downloadLink.download = `${route.id}.gpx`;
}


function updateSummary() {
  updateRouteStats();
  updateDownloadLink();
}


function updateUrl() {
  const query = new URLSearchParams(window.location.search);
  query.set("area", areaSelect.value);
  query.set("start", startSelect.value);
  query.set("end", endSelect.value);
  window.history.replaceState({}, "", `${window.location.pathname}?${query.toString()}`);
}


function chooseRoute() {
  const scenario = currentScenario();
  if (!scenario) {
    appState.route = null;
    return;
  }
  const routeRef = randomRoute(scenario.routes, appState.route?.id);
  appState.route = routeRef ? materializeRoute(routeRef, appState.area) : null;
  updateUrl();
  updateSummary();
  renderRoute();
}


function populateAreaOptions() {
  areaSelect.innerHTML = "";
  appState.catalog.areas.forEach((area) => {
    const option = document.createElement("option");
    option.value = area.id;
    option.textContent = area.name;
    areaSelect.append(option);
  });
}


function populateJunctionSelectors(area, requestedStart, requestedEnd) {
  startSelect.innerHTML = "";
  endSelect.innerHTML = "";
  area.junctions.forEach((junction) => {
    const startOption = document.createElement("option");
    startOption.value = junction.id;
    startOption.textContent = junction.name;
    startSelect.append(startOption);

    const endOption = document.createElement("option");
    endOption.value = junction.id;
    endOption.textContent = junction.name;
    endSelect.append(endOption);
  });

  const exactScenario = area.scenarios.find(
    (item) =>
      item.start_junction_id === requestedStart && item.end_junction_id === requestedEnd
  ) ?? area.scenarios[0];

  startSelect.value = exactScenario.start_junction_id;
  endSelect.value = exactScenario.end_junction_id;
}


function syncSelectorsFromQuery() {
  const query = new URLSearchParams(window.location.search);
  const requestedAreaId = query.get("area") || appState.catalog.areas[0].id;
  appState.area = appState.catalog.areas.find((item) => item.id === requestedAreaId) ?? appState.catalog.areas[0];
  populateAreaOptions();
  areaSelect.value = appState.area.id;

  const requestedStart = query.get("start") || appState.area.scenarios[0].start_junction_id;
  const requestedEnd = query.get("end") || appState.area.scenarios[0].end_junction_id;
  populateJunctionSelectors(appState.area, requestedStart, requestedEnd);
}


async function loadAreaNetwork() {
  const networkUrl = networkUrls[appState.area.id];
  if (!networkUrl) {
    appState.network = null;
    return;
  }
  const response = await fetch(networkUrl);
  if (!response.ok) {
    throw new Error(`Failed to load network overlay: ${response.status}`);
  }
  appState.network = await response.json();
  renderNetwork();
}


async function boot() {
  try {
    clearError();
    const response = await fetch(catalogUrl);
    if (!response.ok) {
      throw new Error(`Failed to load route catalog: ${response.status}`);
    }
    appState.catalog = await response.json();
    appState.catalog.areas.forEach(buildRouteFamilyIndex);
    syncSelectorsFromQuery();
    await loadAreaNetwork();
    chooseRoute();

    areaSelect.addEventListener("change", async () => {
      appState.area = appState.catalog.areas.find((item) => item.id === areaSelect.value) ?? appState.catalog.areas[0];
      areaSelect.value = appState.area.id;
      populateJunctionSelectors(
        appState.area,
        appState.area.scenarios[0].start_junction_id,
        appState.area.scenarios[0].end_junction_id
      );
      await loadAreaNetwork();
      chooseRoute();
    });

    startSelect.addEventListener("change", chooseRoute);
    endSelect.addEventListener("change", chooseRoute);
    newRouteButton.addEventListener("click", chooseRoute);
  } catch (error) {
    showError(error.message || String(error));
  }
}


boot();


window.setInterval(() => {
  appState.loopArrowPhase = (appState.loopArrowPhase + 1) % 2;
  const scenario = currentScenario();
  if (appState.route && scenario?.is_loop) {
    updateRouteStats();
  }
}, LOOP_ARROW_INTERVAL_MS);
