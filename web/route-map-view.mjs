const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route map view module");
const {
  hasExplicitRoutingInclude,
  isBoundaryDefaultExcluded,
  isCurrentlyUnavailable,
} = await import(`./karura-policy.mjs${moduleSuffix}`);

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

function junctionLatLon(junction) {
  if (!junction) {
    return null;
  }
  return [junction.location.lat, junction.location.lon];
}

function networkFeatureStyle(feature) {
  const tags = feature?.properties?.tags || {};
  if (isBoundaryDefaultExcluded(tags) && !hasExplicitRoutingInclude(tags)) {
    return {
      color: "#9a8759",
      weight: 3,
      opacity: 0.5,
      dashArray: "8 8",
      lineCap: "round",
    };
  }
  if (isCurrentlyUnavailable(tags)) {
    return {
      color: "#d0741f",
      weight: 3,
      opacity: 0.72,
      dashArray: "10 6",
      lineCap: "round",
    };
  }
  return {
    color: "#3d4f46",
    weight: 2,
    opacity: 0.33,
  };
}

function bindNetworkFeature(layer, feature) {
  const tags = feature?.properties?.tags || {};
  if (isBoundaryDefaultExcluded(tags) && !hasExplicitRoutingInclude(tags)) {
    layer.bindTooltip("Outside core boundary; excluded by default", {
      direction: "top",
      sticky: true,
    });
    if (!isCurrentlyUnavailable(tags)) {
      return;
    }
  }
  if (isCurrentlyUnavailable(tags)) {
    const until = tags["local:unavailable_until"];
    const message = typeof until === "string"
      ? `Temporarily unavailable until ${until}`
      : "Temporarily unavailable";
    layer.bindTooltip(message, {
      direction: "top",
      sticky: true,
    });
  }
}

export function createRouteMapView(elementId) {
  let map = null;
  let networkLayer = null;
  let routeLayer = null;
  let markerLayer = null;

  function ensureMap() {
    if (map) {
      return map;
    }
    map = L.map(elementId, {
      zoomControl: false,
      preferCanvas: true,
    });
    map.setView([-1.2418, 36.8315], 14);
    map.createPane("network-pane");
    map.getPane("network-pane").style.zIndex = "350";
    map.createPane("route-pane");
    map.getPane("route-pane").style.zIndex = "450";
    map.createPane("marker-pane");
    map.getPane("marker-pane").style.zIndex = "500";
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);
    return map;
  }

  function renderBackgroundNetwork(network) {
    const activeMap = ensureMap();
    if (networkLayer) {
      networkLayer.remove();
    }
    if (!network) {
      networkLayer = null;
      return;
    }
    networkLayer = L.geoJSON(network, {
      style: networkFeatureStyle,
      onEachFeature: bindNetworkFeature,
      pane: "network-pane",
    }).addTo(activeMap);
  }

  function renderRoute(route, { scenario, startJunction, endJunction }) {
    const activeMap = ensureMap();
    if (routeLayer) {
      routeLayer.remove();
      routeLayer = null;
    }
    if (markerLayer) {
      markerLayer.remove();
      markerLayer = null;
    }
    if (!route || !scenario) {
      return;
    }

    routeLayer = L.layerGroup();
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
          pane: "route-pane",
        }
      ).addTo(routeLayer);
    });

    markerLayer = L.layerGroup();
    const startLatLon = junctionLatLon(startJunction);
    const endLatLon = junctionLatLon(endJunction);
    if (startJunction && startLatLon) {
      L.circleMarker(startLatLon, {
        radius: 7,
        color: "#ffffff",
        weight: 3,
        fillColor: "#2d8c4d",
        fillOpacity: 1,
        pane: "marker-pane",
      }).bindTooltip(`Start: ${startJunction.name}`, { direction: "top" }).addTo(markerLayer);
    }
    if (endJunction && endLatLon) {
      L.circleMarker(endLatLon, {
        radius: 7,
        color: "#ffffff",
        weight: 3,
        fillColor: "#245ac9",
        fillOpacity: 1,
        pane: "marker-pane",
      }).bindTooltip(`End: ${endJunction.name}`, { direction: "top" }).addTo(markerLayer);
    }

    routeLayer.addTo(activeMap);
    markerLayer.addTo(activeMap);
    activeMap.fitBounds(boundsToLeaflet(route.bounds), {
      padding: [28, 28],
      maxZoom: 16,
    });
  }

  return {
    ensureMap,
    renderBackgroundNetwork,
    renderRoute,
  };
}
