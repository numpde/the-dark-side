function formatDistance(lengthM) {
  return `${(lengthM / 1000).toFixed(2)} km`;
}

function formatElevationChange(lengthM) {
  return `${lengthM.toFixed(0)} m`;
}

function animatedLoopArrow(loopArrowPhase) {
  return loopArrowPhase % 2 === 0 ? "↗" : "↘";
}

function setScenarioLabelParts(labelElement, title, metaText) {
  labelElement.replaceChildren();
  const titleSpan = document.createElement("span");
  titleSpan.className = "scenario-title-main";
  titleSpan.textContent = title;

  if (!metaText) {
    labelElement.append(titleSpan);
    return;
  }

  const separatorSpan = document.createElement("span");
  separatorSpan.className = "scenario-title-separator";
  separatorSpan.textContent = ", ";

  const metaSpan = document.createElement("span");
  metaSpan.className = "scenario-title-meta";
  metaSpan.textContent = metaText;

  labelElement.append(titleSpan, separatorSpan, metaSpan);
}

export function setSummaryText(labelElement, text) {
  labelElement.textContent = text;
}

export function renderRouteSummary(labelElement, { title, route, routeStatus, isLoop, loopArrowPhase }) {
  if (!title) {
    setSummaryText(labelElement, "Loading routes…");
    return;
  }

  if (routeStatus === "loading" && !route) {
    setSummaryText(labelElement, `${title}…`);
    return;
  }

  if (!route) {
    setSummaryText(labelElement, title);
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
  setScenarioLabelParts(labelElement, title, metaText);
}
