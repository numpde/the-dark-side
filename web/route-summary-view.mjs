function formatDistance(lengthM) {
  return `${(lengthM / 1000).toFixed(2)} km`;
}

function formatElevationChange(lengthM) {
  return `${lengthM.toFixed(0)} m`;
}

function animatedLoopArrow(loopArrowPhase) {
  return loopArrowPhase % 2 === 0 ? "↗" : "↘";
}

function setScenarioLabelMeta(labelElement, metaText, noteText = null) {
  labelElement.replaceChildren();
  const metaSpan = document.createElement("span");
  metaSpan.className = "scenario-title-meta";
  metaSpan.textContent = metaText;
  labelElement.append(metaSpan);
  if (!noteText) {
    return;
  }
  const noteSpan = document.createElement("span");
  noteSpan.className = "scenario-title-note";
  noteSpan.textContent = noteText;
  labelElement.append(noteSpan);
}

export function setSummaryText(labelElement, text) {
  labelElement.textContent = text;
}

export function renderRouteSummary(labelElement, { route, routeStatus, isLoop, loopArrowPhase }) {
  if (routeStatus === "loading" && !route) {
    setSummaryText(labelElement, "Computing route…");
    return;
  }

  if (!route) {
    setSummaryText(labelElement, "Loading routes…");
    return;
  }

  const hasGain = typeof route.elevation_gain_m === "number";
  const hasLoss = typeof route.elevation_loss_m === "number";
  let metaText = formatDistance(route.unique_length_m);
  if (isLoop && hasGain && hasLoss) {
    const averageChange = (route.elevation_gain_m + route.elevation_loss_m) / 2;
    metaText += ` (${animatedLoopArrow(loopArrowPhase)} ${formatElevationChange(averageChange)})`;
  } else if (hasGain || hasLoss) {
    const upText = hasGain ? formatElevationChange(route.elevation_gain_m) : "—";
    const downText = hasLoss ? formatElevationChange(route.elevation_loss_m) : "—";
    metaText += ` (↗ ${upText}, ↘ ${downText})`;
  }
  setScenarioLabelMeta(labelElement, metaText);
}
