import { TRACE_WAY_TAG_PRESETS } from "./editor-config.js?v=20260427aw";
import {
  buildTraceOsmExport,
  projectLatLonToImagePoint,
  resolveTraceVertexPlacement,
  traceVertexSnapWouldCycle,
} from "./editor-fit.js?v=20260427aw";

const SVG_NS = "http://www.w3.org/2000/svg";
const TRACE_SNAP_DISTANCE_PX = 14;
const TRACE_SEGMENT_SNAP_DISTANCE_PX = 10;

export function createRenderer({ dom, map, markerLayer, store, actions }) {
  let regionLayer = null;
  let regionGeoJsonData = null;
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
    trace: {
      navigating: false,
      viewportPoint: null,
      hostElement: dom.traceViewport,
      ghostElement: dom.tracePlacementGhost,
      ghostIndexElement: dom.tracePlacementGhostIndex,
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
    dom.traceImage.src = encodeURI(figure.imagePath);
    dom.screenshotImage.onload = () => {
      renderImageStage();
    };
    dom.traceImage.onload = () => {
      renderTraceStage();
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
    store.ensureTraceViewForCurrentFigure(dom.traceViewport);
    resetPlacementPreviewState();
    await loadRegionOverlay(figure);
    drawApproxBounds(figure.approxBounds);
    renderAll();
  }

  function renderAll() {
    renderSelectionStrip();
    renderControlStates();
    renderImageStage();
    renderTraceStage();
    renderPointList();
    renderWayList();
    renderTraceTagEditor();
    renderMapMarkers();
    renderImagePlacementGhost();
    renderTracePlacementGhost();
    renderMapPlacementGhost();
    renderFitOverlay();
    renderTraceExport();
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
    const traceState = store.getCurrentTrace();
    const selectedTraceWay = store.getSelectedTraceWay(traceState);
    dom.undoButton.disabled = !store.canUndoCurrentFigure();
    dom.deletePointButton.disabled = !selectedPoint;
    dom.clearPointsButton.disabled = figureState.points.length === 0 && !hasFit;
    dom.fitButton.disabled = store.getPairedPointCount(figureState) < fitMode.minControlPoints;
    dom.copyFitButton.disabled = !store.getCurrentFit()?.output;
    dom.deleteWayButton.disabled = !selectedTraceWay;
    dom.deleteVertexButton.disabled = !store.getSelectedTraceVertex(traceState);
    dom.traceWayPreset.disabled = !selectedTraceWay;
    dom.traceWayHighway.disabled = !selectedTraceWay;
    dom.traceWayFoot.disabled = !selectedTraceWay;
    dom.traceWayBicycle.disabled = !selectedTraceWay;
    dom.traceWayMtbScale.disabled = !selectedTraceWay;
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

  function renderTraceStage() {
    const figure = store.getCurrentFigure();
    if (!figure) {
      return;
    }
    const traceView = store.getCurrentTraceView() ?? store.ensureTraceViewForCurrentFigure(dom.traceViewport);
    if (!traceView) {
      return;
    }
    dom.traceCanvas.style.width = `${figure.imageSize.width}px`;
    dom.traceCanvas.style.height = `${figure.imageSize.height}px`;
    dom.traceImage.style.width = `${figure.imageSize.width}px`;
    dom.traceImage.style.height = `${figure.imageSize.height}px`;
    dom.traceCanvas.style.transform = `translate(${traceView.offsetX}px, ${traceView.offsetY}px) scale(${traceView.scale})`;
    dom.traceOverlay.setAttribute("viewBox", `0 0 ${dom.traceViewport.clientWidth} ${dom.traceViewport.clientHeight}`);
    renderTraceGeometry(traceView);
    renderTracePlacementGhost();
  }

  function renderTraceGeometry(traceView) {
    const traceState = store.getCurrentTrace();
    const fitRecord = store.getCurrentFit();
    const selectedWayId = store.getSelectedTraceWay(traceState)?.id ?? null;
    const selectedVertexId = store.getSelectedTraceVertex(traceState)?.id ?? null;
    dom.traceOverlay.replaceChildren();

    if (fitRecord && regionGeoJsonData) {
      renderProjectedRegionGeometry({
        overlayElement: dom.traceOverlay,
        regionGeoJsonData,
        fitRecord,
        traceView,
        figure: store.getCurrentFigure(),
      });
    }

    for (const way of traceState.ways) {
      if (!way.vertices.length) {
        continue;
      }
      const points = way.vertices.map((vertex) => projectTraceVertex({ traceView, traceState, wayId: way.id, vertex }));
      if (points.length >= 2) {
        const line = document.createElementNS(SVG_NS, "polyline");
        line.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
        line.setAttribute("class", `trace-way-line${way.id === selectedWayId ? " active" : ""}`);
        dom.traceOverlay.append(line);

        const hit = document.createElementNS(SVG_NS, "polyline");
        hit.setAttribute("points", line.getAttribute("points"));
        hit.setAttribute("class", "trace-way-hit");
        hit.setAttribute("data-trace-way-id", String(way.id));
        dom.traceOverlay.append(hit);
      }

      for (const point of points) {
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("cx", String(point.x));
        circle.setAttribute("cy", String(point.y));
        circle.setAttribute("r", "11");
        circle.setAttribute("class", `trace-vertex${point.vertex.id === selectedVertexId ? " active" : ""}`);
        circle.setAttribute("data-trace-way-id", String(way.id));
        circle.setAttribute("data-trace-vertex-id", String(point.vertex.id));
        dom.traceOverlay.append(circle);

        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(point.x));
        label.setAttribute("y", String(point.y));
        label.setAttribute("class", "trace-vertex-label");
        label.textContent = String(point.vertex.id);
        dom.traceOverlay.append(label);
      }
    }
  }

  function renderWayList() {
    const traceState = store.getCurrentTrace();
    const selectedWayId = store.getSelectedTraceWay(traceState)?.id ?? null;
    dom.wayList.innerHTML = "";

    if (!traceState.ways.length) {
      const empty = document.createElement("div");
      empty.className = "status";
      empty.textContent = "No traced ways yet. Add a way or click in the tracing pane to start one.";
      dom.wayList.append(empty);
      return;
    }

    for (const way of traceState.ways) {
      const resolvedVertices = way.vertices.map((vertex) => ({
        vertex,
        resolved: resolveTraceVertexPlacement(traceState, way.id, vertex.id),
      }));
      const item = document.createElement("button");
      item.type = "button";
      item.className = `point-item${way.id === selectedWayId ? " active" : ""}`;
      item.addEventListener("click", () => {
        actions.selectTraceWay(way.id);
      });
      item.innerHTML = `
        <span class="point-index">W${way.id}</span>
        <span class="point-lines">
          <span class="point-status">${store.formatCount(way.vertices.length, "vertex")} · ${store.formatCount(resolvedVertices.filter(({ resolved }) => resolved?.osmNodeId).length, "existing node")}</span>
          <code>${way.vertices.length ? describeTraceVertex(way.vertices[0], "start") : "empty way"}</code>
          <code>${way.vertices.length ? describeTraceVertex(way.vertices.at(-1), "end") : "click to add a vertex"}</code>
        </span>
      `;
      dom.wayList.append(item);
    }
  }

  function renderTraceTagEditor() {
    const selectedWay = store.getSelectedTraceWay();
    if (!selectedWay) {
      dom.traceWayPreset.value = "custom";
      dom.traceWayHighway.value = "";
      dom.traceWayFoot.value = "";
      dom.traceWayBicycle.value = "";
      dom.traceWayMtbScale.value = "";
      dom.traceTagStatusBox.textContent = "Select a way to edit its OSM tags.";
      return;
    }

    const tags = {
      highway: selectedWay.tags?.highway ?? "",
      foot: selectedWay.tags?.foot ?? "",
      bicycle: selectedWay.tags?.bicycle ?? "",
      mtbScale: selectedWay.tags?.mtbScale ?? "",
    };
    dom.traceWayPreset.value = getTraceWayPresetKey(tags);
    dom.traceWayHighway.value = tags.highway;
    dom.traceWayFoot.value = tags.foot;
    dom.traceWayBicycle.value = tags.bicycle;
    dom.traceWayMtbScale.value = tags.mtbScale;
    const tagSummary = buildTraceWayTagSummary(tags);
    dom.traceTagStatusBox.textContent = `Editing W${selectedWay.id}. ${tagSummary}`;
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

  function renderTracePlacementGhost() {
    const previewState = placementPreviewState.trace;
    const traceState = store.getCurrentTrace();
    const placementPointId = traceState.nextVertexNumber;
    const viewportPoint = previewState.viewportPoint;
    const selectedWay = store.getSelectedTraceWay(traceState);
    const placement = viewportPoint
      ? resolveTracePlacement(viewportPoint, {
          sourceWayId: selectedWay?.id ?? null,
          sourceVertexId: null,
        })
      : null;
    const shouldShow = placementPointId != null && placement && !previewState.navigating;
    setPlacementPreviewVisible(previewState, shouldShow);
    if (!shouldShow) {
      return;
    }
    previewState.ghostElement.style.left = `${placement.viewportX}px`;
    previewState.ghostElement.style.top = `${placement.viewportY}px`;
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

    dom.traceViewport.addEventListener("pointermove", (event) => {
      const rect = dom.traceViewport.getBoundingClientRect();
      placementPreviewState.trace.viewportPoint = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      renderTracePlacementGhost();
    });
    dom.traceViewport.addEventListener("mouseleave", () => {
      placementPreviewState.trace.viewportPoint = null;
      renderTracePlacementGhost();
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

  function renderTraceExport() {
    const figure = store.getCurrentFigure();
    const fitRecord = store.getCurrentFit();
    const traceState = store.getCurrentTrace();
    const selectedWay = store.getSelectedTraceWay(traceState);
    const traceWayCount = traceState.ways.length;
    const totalVertexCount = traceState.ways.reduce((sum, way) => sum + way.vertices.length, 0);

    if (!selectedWay) {
      dom.traceExportBox.textContent = "No way selected yet.";
      dom.copyTraceExportButton.disabled = true;
      setTraceStatus(
        traceWayCount
          ? `Select one traced way to preview its OSM changeset. ${store.formatCount(traceWayCount, "way")} available.`
          : "Trace and select a way to preview its OSM changeset."
      );
      return;
    }

    if (!fitRecord) {
      dom.traceExportBox.textContent = "No fit available for this figure yet.";
      dom.copyTraceExportButton.disabled = true;
      setTraceStatus(
        `Selected W${selectedWay.id} has ${store.formatCount(selectedWay.vertices.length, "vertex")}, but export is blocked until you run Fit.`
      );
      return;
    }

    try {
      const traceExport = buildTraceOsmExport({
        figure,
        fitRecord,
        trace: traceState,
        regionGeoJsonData,
        selectedWayId: selectedWay.id,
      });
      dom.traceExportBox.textContent = traceExport.osmChangeXml;
      dom.copyTraceExportButton.disabled = traceExport.wayCount === 0;
      if (!traceExport.wayCount) {
        setTraceStatus(
          `Selected W${selectedWay.id} is not exportable yet. Ways need at least 2 vertices.`
        );
        return;
      }
      setTraceStatus(
        `Selected W${selectedWay.id}: prepared ${store.formatCount(traceExport.wayCount, "new way")}, ${store.formatCount(traceExport.modifiedWayCount, "existing way modification")} and ${store.formatCount(traceExport.ways.reduce((sum, way) => sum + way.nodes.filter((node) => !node.existing).length, 0), "new node")} for OSM changeset upload.`
      );
    } catch (error) {
      dom.traceExportBox.textContent = error.message || String(error);
      dom.copyTraceExportButton.disabled = true;
      setTraceStatus(`Trace export failed: ${error.message || String(error)}`);
    }
  }

  function setStatus(message) {
    dom.statusBox.textContent = message;
  }

  function setTraceStatus(message) {
    dom.traceStatusBox.textContent = message;
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
    regionGeoJsonData = await response.json();
    regionLayer = L.geoJSON(regionGeoJsonData, {
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
    if (previewKey === "trace") {
      renderTracePlacementGhost();
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
    setTraceStatus,
    setImagePlacementPreviewNavigating(navigating) {
      setPlacementPreviewNavigating("image", navigating);
    },
    setTracePlacementPreviewNavigating(navigating) {
      setPlacementPreviewNavigating("trace", navigating);
    },
    renderTraceStage,
    resolveTracePlacement,
  };

  function resolveTracePlacement(viewportPoint, context = {}) {
    const figure = store.getCurrentFigure();
    const traceView = store.getCurrentTraceView();
    const traceState = store.getCurrentTrace();
    if (!figure || !traceView || !viewportPoint) {
      return null;
    }
    const imageX = (viewportPoint.x - traceView.offsetX) / traceView.scale;
    const imageY = (viewportPoint.y - traceView.offsetY) / traceView.scale;
    const insideImage =
      imageX >= 0 &&
      imageY >= 0 &&
      imageX <= figure.imageSize.width &&
      imageY <= figure.imageSize.height;
    if (!insideImage) {
      return null;
    }
    const snappedTraceVertex = findNearestProjectedTraceVertex({
      traceState,
      traceView,
      viewportPoint,
      sourceWayId: context.sourceWayId ?? null,
      sourceVertexId: context.sourceVertexId ?? null,
    });
    if (snappedTraceVertex) {
      return {
        x: snappedTraceVertex.image.x,
        y: snappedTraceVertex.image.y,
        viewportX: snappedTraceVertex.viewport.x,
        viewportY: snappedTraceVertex.viewport.y,
        osmNodeId: null,
        osmLat: null,
        osmLon: null,
        segmentSnap: null,
        traceVertexSnap: {
          wayId: snappedTraceVertex.wayId,
          vertexId: snappedTraceVertex.vertexId,
        },
      };
    }
    const snappedNode = findNearestProjectedRegionNode({
      regionGeoJsonData,
      fitRecord: store.getCurrentFit(),
      traceView,
      viewportPoint,
      figure,
    });
    if (snappedNode) {
      return {
        x: snappedNode.image.x,
        y: snappedNode.image.y,
        viewportX: snappedNode.viewport.x,
        viewportY: snappedNode.viewport.y,
        osmNodeId: snappedNode.id,
        osmLat: snappedNode.map.lat,
        osmLon: snappedNode.map.lon,
        traceVertexSnap: null,
      };
    }
    const snappedSegment = findNearestProjectedRegionSegment({
      regionGeoJsonData,
      fitRecord: store.getCurrentFit(),
      traceView,
      viewportPoint,
      figure,
    });
    if (snappedSegment) {
      return {
        x: snappedSegment.image.x,
        y: snappedSegment.image.y,
        viewportX: snappedSegment.viewport.x,
        viewportY: snappedSegment.viewport.y,
        osmNodeId: null,
        osmLat: snappedSegment.map.lat,
        osmLon: snappedSegment.map.lon,
        segmentSnap: {
          wayId: snappedSegment.wayId,
          wayVersion: snappedSegment.wayVersion,
          segmentIndex: snappedSegment.segmentIndex,
          startNodeId: snappedSegment.startNodeId,
          endNodeId: snappedSegment.endNodeId,
          t: snappedSegment.t,
        },
        traceVertexSnap: null,
      };
    }
    return {
      x: roundTo(imageX, 2),
      y: roundTo(imageY, 2),
      viewportX: viewportPoint.x,
      viewportY: viewportPoint.y,
      osmNodeId: null,
      osmLat: null,
      osmLon: null,
      segmentSnap: null,
      traceVertexSnap: null,
    };
  }
}

function projectTraceVertex({ traceView, traceState, wayId, vertex }) {
  const resolved = resolveTraceVertexPlacement(traceState, wayId, vertex.id);
  const imageX = resolved?.x ?? vertex.x;
  const imageY = resolved?.y ?? vertex.y;
  return {
    x: traceView.offsetX + imageX * traceView.scale,
    y: traceView.offsetY + imageY * traceView.scale,
    image: {
      x: imageX,
      y: imageY,
    },
    resolved,
    vertex,
  };
}

function describeTraceVertex(vertex, prefix) {
  const suffix = vertex.osmNodeId
    ? `node ${vertex.osmNodeId}`
    : vertex.traceVertexSnap
      ? `W${vertex.traceVertexSnap.wayId}:V${vertex.traceVertexSnap.vertexId}`
    : vertex.segmentSnap
      ? `segment ${vertex.segmentSnap.wayId}:${vertex.segmentSnap.segmentIndex}`
      : `${vertex.x.toFixed(1)}, ${vertex.y.toFixed(1)} px`;
  return `${prefix}: ${suffix}`;
}

function findNearestProjectedTraceVertex({ traceState, traceView, viewportPoint, sourceWayId, sourceVertexId }) {
  if (!traceState?.ways?.length) {
    return null;
  }
  let bestVertex = null;
  let bestDistance = TRACE_SNAP_DISTANCE_PX;
  for (const way of traceState.ways) {
    if (sourceWayId != null && way.id === sourceWayId) {
      continue;
    }
    for (const vertex of way.vertices) {
      if (sourceWayId != null && sourceVertexId != null) {
        if (traceVertexSnapWouldCycle(traceState, sourceWayId, sourceVertexId, way.id, vertex.id)) {
          continue;
        }
      }
      const projected = projectTraceVertex({ traceView, traceState, wayId: way.id, vertex });
      const dx = projected.x - viewportPoint.x;
      const dy = projected.y - viewportPoint.y;
      const distance = Math.hypot(dx, dy);
      if (distance > bestDistance) {
        continue;
      }
      bestDistance = distance;
      bestVertex = {
        wayId: way.id,
        vertexId: vertex.id,
        image: projected.image,
        viewport: {
          x: projected.x,
          y: projected.y,
        },
      };
    }
  }
  return bestVertex;
}

function renderProjectedRegionGeometry({ overlayElement, regionGeoJsonData, fitRecord, traceView, figure }) {
  const projected = projectRegionGeometry(regionGeoJsonData, fitRecord, traceView, figure);
  for (const segment of projected.segments) {
    const points = `${segment.start.viewport.x},${segment.start.viewport.y} ${segment.end.viewport.x},${segment.end.viewport.y}`;
    const halo = document.createElementNS(SVG_NS, "polyline");
    halo.setAttribute("points", points);
    halo.setAttribute("class", "region-trace-line-halo");
    overlayElement.append(halo);

    const line = document.createElementNS(SVG_NS, "polyline");
    line.setAttribute("points", points);
    line.setAttribute("class", "region-trace-line");
    overlayElement.append(line);
  }
  for (const node of projected.nodes) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(node.viewport.x));
    circle.setAttribute("cy", String(node.viewport.y));
    circle.setAttribute("r", "5");
    circle.setAttribute("class", "region-trace-node");
    circle.setAttribute("data-region-node-id", String(node.id));
    overlayElement.append(circle);
  }
}

function projectRegionGeometry(regionGeoJsonData, fitRecord, traceView, figure) {
  const nodesById = new Map();
  const segments = [];
  const imageBounds = {
    minX: 0,
    minY: 0,
    maxX: figure.imageSize.width,
    maxY: figure.imageSize.height,
  };
  for (const feature of regionGeoJsonData?.features || []) {
    const coordinates = feature?.geometry?.coordinates || [];
    const nodeIds = feature?.properties?.node_ids || [];
    const wayId = feature?.properties?.way_id;
    const wayVersion = feature?.properties?.way_version ?? null;
    for (let index = 0; index < coordinates.length; index += 1) {
      const [lon, lat] = coordinates[index];
      const image = projectLatLonToImagePoint(fitRecord, lat, lon);
      const viewport = {
        x: traceView.offsetX + image.x * traceView.scale,
        y: traceView.offsetY + image.y * traceView.scale,
      };
      const nodeId = nodeIds[index];
      const insideImage = isPointInsideImageBounds(image, imageBounds);
      if (nodeId && insideImage && !nodesById.has(nodeId)) {
        nodesById.set(nodeId, {
          id: nodeId,
          image,
          viewport,
          map: { lat, lon },
        });
      }
      if (index > 0) {
        const previousCoordinate = coordinates[index - 1];
        const previousImage = projectLatLonToImagePoint(fitRecord, previousCoordinate[1], previousCoordinate[0]);
        const previousViewport = {
          x: traceView.offsetX + previousImage.x * traceView.scale,
          y: traceView.offsetY + previousImage.y * traceView.scale,
        };
        const startNodeId = nodeIds[index - 1];
        const endNodeId = nodeIds[index];
        const clippedSegment = clipSegmentToImageBounds(previousImage, image, imageBounds);
        if (clippedSegment && startNodeId && endNodeId) {
          const clippedStartImage = interpolatePoint(previousImage, image, clippedSegment.startT);
          const clippedEndImage = interpolatePoint(previousImage, image, clippedSegment.endT);
          const clippedStartViewport = interpolatePoint(previousViewport, viewport, clippedSegment.startT);
          const clippedEndViewport = interpolatePoint(previousViewport, viewport, clippedSegment.endT);
          const clippedStartMap = interpolateLatLon(
            { lat: previousCoordinate[1], lon: previousCoordinate[0] },
            { lat, lon },
            clippedSegment.startT
          );
          const clippedEndMap = interpolateLatLon(
            { lat: previousCoordinate[1], lon: previousCoordinate[0] },
            { lat, lon },
            clippedSegment.endT
          );
          segments.push({
            wayId,
            wayVersion,
            segmentIndex: index - 1,
            startNodeId,
            endNodeId,
            startT: clippedSegment.startT,
            endT: clippedSegment.endT,
            start: {
              image: clippedStartImage,
              viewport: clippedStartViewport,
              map: clippedStartMap,
            },
            end: {
              image: clippedEndImage,
              viewport: clippedEndViewport,
              map: clippedEndMap,
            },
          });
        }
      }
    }
  }
  return {
    nodes: [...nodesById.values()],
    segments,
  };
}

function findNearestProjectedRegionNode({ regionGeoJsonData, fitRecord, traceView, viewportPoint, figure }) {
  if (!fitRecord || !regionGeoJsonData) {
    return null;
  }
  const projected = projectRegionGeometry(regionGeoJsonData, fitRecord, traceView, figure);
  let bestNode = null;
  let bestDistance = TRACE_SNAP_DISTANCE_PX;
  for (const node of projected.nodes) {
    const dx = node.viewport.x - viewportPoint.x;
    const dy = node.viewport.y - viewportPoint.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestNode = node;
    }
  }
  return bestNode;
}

function findNearestProjectedRegionSegment({ regionGeoJsonData, fitRecord, traceView, viewportPoint, figure }) {
  if (!fitRecord || !regionGeoJsonData) {
    return null;
  }
  const projected = projectRegionGeometry(regionGeoJsonData, fitRecord, traceView, figure);
  let bestSegment = null;
  let bestDistance = TRACE_SEGMENT_SNAP_DISTANCE_PX;
  for (const segment of projected.segments) {
    const nearest = projectPointToSegment(viewportPoint, segment.start.viewport, segment.end.viewport);
    if (nearest.distance > bestDistance) {
      continue;
    }
    const sourceT = segment.startT + (segment.endT - segment.startT) * nearest.t;
    bestDistance = nearest.distance;
    bestSegment = {
      wayId: segment.wayId,
      wayVersion: segment.wayVersion,
      segmentIndex: segment.segmentIndex,
      startNodeId: segment.startNodeId,
      endNodeId: segment.endNodeId,
      t: sourceT,
      image: {
        x: roundTo(segment.start.image.x + (segment.end.image.x - segment.start.image.x) * nearest.t, 2),
        y: roundTo(segment.start.image.y + (segment.end.image.y - segment.start.image.y) * nearest.t, 2),
      },
      viewport: nearest.point,
      map: {
        lat: roundTo(segment.start.map.lat + (segment.end.map.lat - segment.start.map.lat) * nearest.t, 7),
        lon: roundTo(segment.start.map.lon + (segment.end.map.lon - segment.start.map.lon) * nearest.t, 7),
      },
    };
  }
  return bestSegment;
}

function isPointInsideImageBounds(point, bounds) {
  return (
    point.x >= bounds.minX &&
    point.y >= bounds.minY &&
    point.x <= bounds.maxX &&
    point.y <= bounds.maxY
  );
}

function clipSegmentToImageBounds(start, end, bounds) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let t0 = 0;
  let t1 = 1;

  if (!clipTest(-dx, start.x - bounds.minX)) {
    return null;
  }
  if (!clipTest(dx, bounds.maxX - start.x)) {
    return null;
  }
  if (!clipTest(-dy, start.y - bounds.minY)) {
    return null;
  }
  if (!clipTest(dy, bounds.maxY - start.y)) {
    return null;
  }

  return t0 <= t1 ? { startT: t0, endT: t1 } : null;

  function clipTest(p, q) {
    if (p === 0) {
      return q >= 0;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) {
        return false;
      }
      if (r > t0) {
        t0 = r;
      }
      return true;
    }
    if (r < t0) {
      return false;
    }
    if (r < t1) {
      t1 = r;
    }
    return true;
  }
}

function interpolatePoint(start, end, t) {
  return {
    x: roundTo(start.x + (end.x - start.x) * t, 2),
    y: roundTo(start.y + (end.y - start.y) * t, 2),
  };
}

function interpolateLatLon(start, end, t) {
  return {
    lat: roundTo(start.lat + (end.lat - start.lat) * t, 7),
    lon: roundTo(start.lon + (end.lon - start.lon) * t, 7),
  };
}

function projectPointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return {
      t: 0,
      point: { x: start.x, y: start.y },
      distance: Math.hypot(point.x - start.x, point.y - start.y),
    };
  }
  const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const t = Math.min(1, Math.max(0, rawT));
  const projectedPoint = {
    x: start.x + dx * t,
    y: start.y + dy * t,
  };
  return {
    t,
    point: projectedPoint,
    distance: Math.hypot(point.x - projectedPoint.x, point.y - projectedPoint.y),
  };
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getTraceWayPresetKey(tags) {
  for (const [presetKey, preset] of Object.entries(TRACE_WAY_TAG_PRESETS)) {
    if (!preset) {
      continue;
    }
    if (
      preset.highway === tags.highway &&
      preset.foot === tags.foot &&
      preset.bicycle === tags.bicycle &&
      preset.mtbScale === tags.mtbScale
    ) {
      return presetKey;
    }
  }
  return "custom";
}

function buildTraceWayTagSummary(tags) {
  const parts = [];
  if (tags.highway) {
    parts.push(`highway=${tags.highway}`);
  }
  if (tags.foot) {
    parts.push(`foot=${tags.foot}`);
  }
  if (tags.bicycle) {
    parts.push(`bicycle=${tags.bicycle}`);
  }
  if (tags.mtbScale) {
    parts.push(`mtb:scale=${tags.mtbScale}`);
  }
  return parts.length ? parts.join(" · ") : "No OSM feature tags set yet.";
}

function waitForPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
