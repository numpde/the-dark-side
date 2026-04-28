
export function styleForPolicy(policy, feature, isCurrentlyUnavailable) {
  const isBufferZone = feature?.properties?.tags?.["local:boundary_zone"] === "buffer";
  const bikeability = policy.bikeability == null ? 0 : Number(policy.bikeability);
  const extraWeight = Math.max(0, bikeability - 1) * 0.5;
  if (isCurrentlyUnavailable(policy)) {
    return {
      color: "#c07a2d",
      weight: 4 + extraWeight,
      opacity: 0.9,
      dashArray: "8 6",
    };
  }
  if (policy.routingState === "include") {
    return {
      color: "#2d8c4d",
      weight: 4 + extraWeight,
      opacity: 0.9,
    };
  }
  if (isBufferZone && policy.routingState === "exclude") {
    return {
      color: "#c07a2d",
      weight: 3.6 + extraWeight,
      opacity: 0.82,
      dashArray: "8 6",
    };
  }
  if (policy.routingState === "exclude") {
    return {
      color: "#bf3a34",
      weight: 4 + extraWeight,
      opacity: 0.88,
      dashArray: "10 7",
    };
  }
  if (policy.bikeability != null || policy.bicycleDirection !== "both") {
    return {
      color: "#315b72",
      weight: 3.4 + extraWeight,
      opacity: 0.8,
    };
  }
  return {
    color: "#3d4f46",
    weight: 3,
    opacity: 0.55,
  };
}

function geometryEndpoints(feature) {
  const geometry = feature.geometry;
  if (!geometry) {
    return { first: null, last: null };
  }
  if (geometry.type === "LineString") {
    return {
      first: geometry.coordinates[0],
      last: geometry.coordinates[geometry.coordinates.length - 1],
    };
  }
  if (geometry.type === "MultiLineString" && geometry.coordinates.length) {
    const firstLine = geometry.coordinates[0];
    const lastLine = geometry.coordinates[geometry.coordinates.length - 1];
    return {
      first: firstLine[0],
      last: lastLine[lastLine.length - 1],
    };
  }
  return { first: null, last: null };
}

function endpointMarker(lat, lon, label) {
  return L.marker([lat, lon], {
    icon: L.divIcon({
      className: "",
      html: `<div class="endpoint-chip">${label}</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    }),
    keyboard: false,
  });
}

export function createEditorMapView({ mapElementId, onSelectContig, resolveFeatureStyle }) {
  let map = null;
  let visibleLayer = null;
  let hitLayer = null;
  let selectedOverlay = null;
  let endpointLayer = null;
  const contigLayers = new Map();
  const contigFeatures = new Map();

  function ensureMap() {
    if (map) {
      return map;
    }
    map = L.map(mapElementId, {
      zoomControl: false,
      preferCanvas: true,
    });
    map.setView([-1.2418, 36.8315], 14);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);
    return map;
  }

  function featureForContig(contigId) {
    return contigFeatures.get(Number(contigId));
  }

  function getContigFeatures() {
    return contigFeatures;
  }

  function wayStyle(feature) {
    return resolveFeatureStyle(feature);
  }

  function updateContigStyle(contigId) {
    const layer = contigLayers.get(Number(contigId));
    const feature = featureForContig(contigId);
    if (!layer || !feature) {
      return;
    }
    layer.setStyle(wayStyle(feature));
  }

  function updateAllContigStyles() {
    for (const contigId of contigLayers.keys()) {
      updateContigStyle(contigId);
    }
  }

  function renderSelectedContig(contigId) {
    const mapInstance = ensureMap();
    if (selectedOverlay) {
      selectedOverlay.remove();
    }
    if (endpointLayer) {
      endpointLayer.remove();
    }

    const feature = featureForContig(contigId);
    if (!feature) {
      selectedOverlay = null;
      endpointLayer = null;
      return;
    }

    const baseStyle = wayStyle(feature);
    const overlay = L.layerGroup();
    L.geoJSON(feature, {
      style: {
        color: "#ffffff",
        weight: baseStyle.weight + 5,
        opacity: 0.95,
      },
    }).addTo(overlay);
    L.geoJSON(feature, {
      style: {
        ...baseStyle,
        weight: baseStyle.weight + 1,
        opacity: 1,
      },
    }).addTo(overlay);
    overlay.addTo(mapInstance);
    selectedOverlay = overlay;

    const { first, last } = geometryEndpoints(feature);
    if (first && last) {
      endpointLayer = L.layerGroup();
      endpointMarker(first[1], first[0], "1").addTo(endpointLayer);
      endpointMarker(last[1], last[0], "2").addTo(endpointLayer);
      endpointLayer.addTo(mapInstance);
    }
  }

  function renderWays(geojson) {
    const mapInstance = ensureMap();
    contigLayers.clear();
    contigFeatures.clear();
    if (visibleLayer) {
      visibleLayer.remove();
    }
    if (hitLayer) {
      hitLayer.remove();
    }

    visibleLayer = L.geoJSON(geojson, {
      style: wayStyle,
      interactive: false,
      onEachFeature(feature, layer) {
        const contigId = Number(feature.properties.contig_id);
        contigLayers.set(contigId, layer);
        contigFeatures.set(contigId, feature);
      },
    }).addTo(mapInstance);

    hitLayer = L.geoJSON(geojson, {
      style: {
        color: "#000000",
        weight: 16,
        opacity: 0.01,
      },
      onEachFeature(feature, layer) {
        const contigId = Number(feature.properties.contig_id);
        layer.on("click", () => onSelectContig(contigId));
      },
    }).addTo(mapInstance);
    mapInstance.fitBounds(hitLayer.getBounds(), { padding: [24, 24], maxZoom: 16 });
  }

  return {
    featureForContig,
    getContigFeatures,
    renderSelectedContig,
    renderWays,
    updateContigStyle,
    updateAllContigStyles,
  };
}
