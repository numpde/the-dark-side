
export const POLICY_TAGS = {
  routingState: "local:routing_state",
  bikeability: "local:bikeability",
  bicycleDirection: "local:bicycle_direction",
  unavailableUntil: "local:unavailable_until",
  legacyAvailability: "local:availability",
};

export function defaultWayPolicy() {
  return {
    routingState: "default",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  };
}

export function normalizeRoutingState(value) {
  return value === "include" || value === "exclude" ? value : "default";
}

export function requireRoutingState(value, label) {
  if (value !== "include" && value !== "exclude") {
    throw new Error(`${label} must be "include" or "exclude"`);
  }
  return value;
}

export function normalizeBikeability(value) {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const rounded = Math.round(numeric);
  if (rounded < 1 || rounded > 5) {
    return null;
  }
  return rounded;
}

export function requireBikeability(value, label) {
  const numeric = normalizeBikeability(value);
  if (numeric == null) {
    throw new Error(`${label} must be an integer from 1 to 5`);
  }
  return numeric;
}

export function normalizeBicycleDirection(value) {
  return value === "forward" || value === "backward" ? value : "both";
}

export function requireBicycleDirection(value, label) {
  if (value !== "both" && value !== "forward" && value !== "backward") {
    throw new Error(`${label} must be "both", "forward", or "backward"`);
  }
  return value;
}

export function normalizeUnavailableUntil(value) {
  if (value == null || value === "") {
    return null;
  }
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    return null;
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
}

export function requireUnavailableUntil(value, label) {
  const normalized = normalizeUnavailableUntil(value);
  if (normalized == null) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
  return normalized;
}
