export function createRenderer({ dom, map, markerLayer, store, actions }) {
  let regionLayer = null;
  let approxBoundsLayer = null;
  let fitPolygonLayer = null;
  const placementPreviewState = {
    image: {
      navigating: false,
      viewportPoint: null,
      hostElement: dom.imageViewport,
      ghostElement: dom.imagePlacementGhost,
      ghostIndexElement: dom.imagePlacementGhostIndex,
    },
    map: {
      navigating: false,
      latlng: null,
      hostElement: map.getContainer(),
      ghostElement: dom.mapPlacementGhost,
      ghostIndexElement: dom.mapPlacementGhostIndex,
    },
  };

  bindPlacementGhostPreviews();

  async function loadCurrentFigureScene({ resetMapView }) {
    const figure = store.getCurrentFigure();
    if (!figure) {
      throw new Error(`Unknown figure: ${store.getUiState().figureId}`);
    }
    dom.figureSelect.value = figure.id;
    dom.screenshotImage.src = encodeURI(figure.imagePath);
    dom.screenshotImage.onload = () => {
      renderImageStage();
    };
    dom.figureMeta.innerHTML = `
      <strong>${figure.label}</strong>
      <span>· ${figure.capturedAt}</span>
      <span>· <a href="${figure.sourceUrl}" target="_blank" rel="noreferrer">Strava link</a></span>
    `;

    if (resetMapView) {
      const seededZoom = Math.max(0, Math.round(figure.view.zoom - 1));
      map.setView([figure.view.center.lat, figure.view.center.lon], seededZoom);
    }

    await waitForPaint();
    map.invalidateSize(false);
    store.ensureImageViewForCurrentFigure(dom.imageViewport);
    resetPlacementPreviewState();
    await loadRegionOverlay(figure);
    drawApproxBounds(figure.approxBounds);
    renderAll();
  }

  function renderAll() {
    renderSelectionStrip();
    renderControlStates();
    renderImageStage();
    renderPointList();
    renderMapMarkers();
    renderImagePlacementGhost();
    renderMapPlacementGhost();
    renderFitOverlay();
  }

  function renderImageStage() {
    const figure = store.getCurrentFigure();
    if (!figure) {
      return;
    }
    const imageView = store.getCurrentImageView() ?? store.ensureImageViewForCurrentFigure(dom.imageViewport);
    if (!imageView) {
      return;
    }
    dom.imageCanvas.style.width = `${figure.imageSize.width}px`;
    dom.imageCanvas.style.height = `${figure.imageSize.height}px`;
    dom.screenshotImage.style.width = `${figure.imageSize.width}px`;
    dom.screenshotImage.style.height = `${figure.imageSize.height}px`;
    dom.imageCanvas.style.transform = `translate(${imageView.offsetX}px, ${imageView.offsetY}px) scale(${imageView.scale})`;
    renderImageMarkers(imageView);
    renderImagePlacementGhost();
  }

  function renderSelectionStrip() {
    const figureState = store.getCurrentFigureState();
    const selectedPoint = store.getSelectedPoint(figureState);
    const pairedCount = store.getPairedPointCount(figureState);
    if (!selectedPoint) {
      dom.selectionStrip.textContent = `No active point. ${store.formatCount(pairedCount, "paired point")} ready. Add one or click directly in the screenshot or map to start.`;
      return;
    }
    const pointDescription = store.describePoint(selectedPoint);
    dom.selectionStrip.textContent = `Active point ${selectedPoint.id} · ${pointDescription.imageStateLabel} · ${pointDescription.mapStateLabel} · ${store.formatCount(pairedCount, "paired point")} total. ${pointDescription.prompt}`;
  }

  function renderControlStates() {
    const figureState = store.getCurrentFigureState();
    const selectedPoint = store.getSelectedPoint(figureState);
    const fitMode = store.getFitMode();
    const hasFit = !!store.getCurrentFit()?.output;
    dom.undoButton.disabled = !store.canUndoCurrentFigure();
    dom.deletePointButton.disabled = !selectedPoint;
    dom.clearPointsButton.disabled = figureState.points.length === 0 && !hasFit;
    dom.fitButton.disabled = store.getPairedPointCount(figureState) < fitMode.minControlPoints;
    dom.copyFitButton.disabled = !store.getCurrentFit()?.output;
  }

  function renderImageMarkers(imageView) {
    const figureState = store.getCurrentFigureState();
    const selectedPoint = store.getSelectedPoint(figureState);
    const selectedPointId = selectedPoint?.id ?? null;
    dom.imageMarkers.innerHTML = "";
    for (const point of figureState.points) {
      if (!point.image) {
        continue;
      }
      const marker = document.createElement("div");
      marker.className = `image-marker${point.id === selectedPointId ? " active" : ""}`;
      marker.textContent = String(point.id);
      marker.style.left = `${imageView.offsetX + point.image.x * imageView.scale}px`;
      marker.style.top = `${imageView.offsetY + point.image.y * imageView.scale}px`;
      dom.imageMarkers.append(marker);
    }
  }

  function renderPointList() {
    const figureState = store.getCurrentFigureState();
    dom.pointList.innerHTML = "";
    if (!figureState.points.length) {
      const empty = document.createElement("div");
      empty.className = "status";
      empty.textContent = "No points yet. Add one, then click the screenshot and map for the same location.";
      dom.pointList.append(empty);
      return;
    }

    const selectedPointId = store.getSelectedPoint(figureState)?.id ?? null;
    for (const point of figureState.points) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `point-item${point.id === selectedPointId ? " active" : ""}`;
      item.addEventListener("click", () => {
        actions.selectPoint(point.id);
      });

      const pointDescription = store.describePoint(point);
      item.innerHTML = `
        <span class="point-index">${point.id}</span>
        <span class="point-lines">
          <span class="point-status">${pointDescription.statusLabel}</span>
          <code>${pointDescription.imageCoordinateLabel}</code>
          <code>${pointDescription.mapCoordinateLabel}</code>
        </span>
      `;
      dom.pointList.append(item);
    }
  }

  function renderMapMarkers() {
    const figureState = store.getCurrentFigureState();
    const selectedPointId = store.getSelectedPoint(figureState)?.id ?? null;
    markerLayer.clearLayers();

    for (const point of figureState.points) {
      if (!point.map) {
        continue;
      }
      const marker = L.marker([point.map.lat, point.map.lon], {
        draggable: true,
        bubblingMouseEvents: false,
        icon: L.divIcon({
          className: "",
          html: `<div class="map-point${point.id === selectedPointId ? " active" : ""}">${point.id}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      });
      marker.on("click", () => {
        actions.selectPoint(point.id);
      });
      marker.on("dragend", (event) => {
        actions.assignPointMap(point.id, event.target.getLatLng());
      });
      marker.addTo(markerLayer);
    }
  }

  function renderImagePlacementGhost() {
    const previewState = placementPreviewState.image;
    const placementPointId = store.getPlacementPointId();
    const figure = store.getCurrentFigure();
    const imageView = store.getCurrentImageView();
    const viewportPoint = previewState.viewportPoint;
    const shouldShow = placementPointId != null && figure && imageView && viewportPoint && !previewState.navigating;
    setPlacementPreviewVisible(previewState, shouldShow);
    if (!shouldShow) {
      return;
    }
    const imageX = (viewportPoint.x - imageView.offsetX) / imageView.scale;
    const imageY = (viewportPoint.y - imageView.offsetY) / imageView.scale;
    const insideImage =
      imageX >= 0 &&
      imageY >= 0 &&
      imageX <= figure.imageSize.width &&
      imageY <= figure.imageSize.height;
    setPlacementPreviewVisible(previewState, insideImage);
    if (!insideImage) {
      return;
    }
    previewState.ghostElement.style.left = `${viewportPoint.x}px`;
    previewState.ghostElement.style.top = `${viewportPoint.y}px`;
    previewState.ghostIndexElement.textContent = String(placementPointId);
  }

  function renderMapPlacementGhost() {
    const previewState = placementPreviewState.map;
    const placementPointId = store.getPlacementPointId();
    const shouldShow = placementPointId != null && previewState.latlng && !previewState.navigating;
    setPlacementPreviewVisible(previewState, shouldShow);
    if (!shouldShow) {
      return;
    }
    const containerPoint = map.latLngToContainerPoint(previewState.latlng);
    previewState.ghostElement.style.left = `${containerPoint.x}px`;
    previewState.ghostElement.style.top = `${containerPoint.y}px`;
    previewState.ghostIndexElement.textContent = String(placementPointId);
  }

  function bindPlacementGhostPreviews() {
    dom.imageViewport.addEventListener("pointermove", (event) => {
      const rect = dom.imageViewport.getBoundingClientRect();
      placementPreviewState.image.viewportPoint = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      renderImagePlacementGhost();
    });
    dom.imageViewport.addEventListener("mouseleave", () => {
      placementPreviewState.image.viewportPoint = null;
      renderImagePlacementGhost();
    });

    map.on("mousemove", (event) => {
      placementPreviewState.map.latlng = event.latlng;
      renderMapPlacementGhost();
    });
    map.on("dragstart", () => {
      setPlacementPreviewNavigating("map", true);
    });
    map.on("dragend", () => {
      setPlacementPreviewNavigating("map", false);
    });
    map.on("move zoom", () => {
      if (!placementPreviewState.map.latlng) {
        return;
      }
      renderMapPlacementGhost();
    });
    map.getContainer().addEventListener("mouseleave", () => {
      placementPreviewState.map.latlng = null;
      renderMapPlacementGhost();
    });
  }

  function renderFitOverlay() {
    if (fitPolygonLayer) {
      map.removeLayer(fitPolygonLayer);
      fitPolygonLayer = null;
    }
    const fit = store.getCurrentFit();
    if (!fit?.polygonLatLngs) {
      dom.resultBox.textContent = "No fit run yet.";
      return;
    }
    fitPolygonLayer = L.polygon(fit.polygonLatLngs, {
      color: "#d62d67",
      weight: 2.5,
      fillOpacity: 0.06,
    }).addTo(map);
    dom.resultBox.textContent = JSON.stringify(fit.output, null, 2);
  }

  function setStatus(message) {
    dom.statusBox.textContent = message;
  }

  function syncOverlayVisibility() {
    const uiState = store.getUiState();
    setLayerVisibility(regionLayer, uiState.showRegion);
    setLayerVisibility(approxBoundsLayer, uiState.showBounds);
  }

  function invalidateMapSize() {
    map.invalidateSize(false);
  }

  async function loadRegionOverlay(figure) {
    if (regionLayer) {
      map.removeLayer(regionLayer);
    }
    const response = await fetch(encodeURI(figure.regionGeoJsonPath), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load region overlay: ${figure.regionGeoJsonPath}`);
    }
    const geojson = await response.json();
    regionLayer = L.geoJSON(geojson, {
      style: (feature) => {
        const highway = feature?.properties?.highway;
        const weight = /motorway|trunk|primary|secondary/.test(highway || "") ? 3.2 : 2.2;
        return {
          color: "rgba(18, 27, 24, 0.72)",
          weight,
          opacity: 0.8,
        };
      },
    });
    syncOverlayVisibility();
  }

  function drawApproxBounds(bounds) {
    if (approxBoundsLayer) {
      map.removeLayer(approxBoundsLayer);
    }
    approxBoundsLayer = L.rectangle([
      [bounds.south, bounds.west],
      [bounds.north, bounds.east],
    ], {
      color: "#205bff",
      weight: 2,
      opacity: 0.7,
      fillOpacity: 0.03,
      dashArray: "8 6",
    });
    syncOverlayVisibility();
  }

  function setLayerVisibility(layer, visible) {
    if (!layer) {
      return;
    }
    if (visible) {
      layer.addTo(map);
      return;
    }
    map.removeLayer(layer);
  }

  function setPlacementPreviewVisible(previewState, visible) {
    previewState.hostElement.classList.toggle("hide-placement-cursor", visible);
    previewState.ghostElement.classList.toggle("hidden", !visible);
  }

  function setPlacementPreviewNavigating(previewKey, navigating) {
    const previewState = placementPreviewState[previewKey];
    if (!previewState || previewState.navigating === navigating) {
      return;
    }
    previewState.navigating = navigating;
    if (previewKey === "image") {
      renderImagePlacementGhost();
      return;
    }
    renderMapPlacementGhost();
  }

  function resetPlacementPreviewState() {
    for (const previewState of Object.values(placementPreviewState)) {
      previewState.navigating = false;
      if ("viewportPoint" in previewState) {
        previewState.viewportPoint = null;
      }
      if ("latlng" in previewState) {
        previewState.latlng = null;
      }
      setPlacementPreviewVisible(previewState, false);
    }
  }

  return {
    loadCurrentFigureScene,
    renderAll,
    renderImageStage,
    syncOverlayVisibility,
    invalidateMapSize,
    setStatus,
    setImagePlacementPreviewNavigating(navigating) {
      setPlacementPreviewNavigating("image", navigating);
    },
  };
}

function waitForPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
