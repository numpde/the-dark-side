export const KARURA_TIME_ZONE = "Africa/Nairobi";


export function karuraTodayString(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KARURA_TIME_ZONE,
  }).format(now);
}


export function isCurrentlyUnavailable(tags = {}, onDateString = karuraTodayString()) {
  if (tags["local:availability"] === "temporarily_unavailable") {
    return true;
  }
  const until = tags["local:unavailable_until"];
  if (typeof until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return false;
  }
  return onDateString <= until;
}


export function boundaryZone(tags = {}) {
  return tags["local:boundary_zone"] === "buffer" ? "buffer" : "core";
}


export function isBoundaryDefaultExcluded(tags = {}) {
  return boundaryZone(tags) === "buffer";
}

export function routingState(tags = {}) {
  return typeof tags["local:routing_state"] === "string"
    ? tags["local:routing_state"]
    : "default";
}

export function hasExplicitRoutingInclude(tags = {}) {
  return routingState(tags) === "include";
}
