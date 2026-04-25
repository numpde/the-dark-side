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


function normalizeRoutingState(value) {
  return value === "include" || value === "exclude" ? value : "default";
}


function normalizeBikeability(value) {
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


function normalizeBicycleDirection(value) {
  return value === "forward" || value === "backward" ? value : "both";
}


function normalizeUnavailableUntil(value) {
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


export function emptyPatchset() {
  return {
    meta: {
      asset_kind: "map_patchset",
      patchset_id: "karura-map-patches-v1",
    },
    patches: [],
  };
}


function managedTagNames() {
  return new Set(Object.values(POLICY_TAGS));
}


function patchTouchesOnlyManagedTags(patch) {
  if (patch.op !== "update_contig_tags") {
        return false;
  }
  const names = managedTagNames();
  const setKeys = Object.keys(patch.set || {});
  const removeKeys = patch.remove || [];
  return [...setKeys, ...removeKeys].every((key) => names.has(key));
}


export function isManagedPolicyPatch(patch) {
  return Boolean(
    patch &&
      patch.enabled !== false &&
      patch.op === "update_contig_tags" &&
      Number.isInteger(Number(patch.contig_id)) &&
      patchTouchesOnlyManagedTags(patch),
  );
}


function applyManagedPatch(policy, patch) {
  const next = { ...policy };
  for (const key of patch.remove || []) {
    if (key === POLICY_TAGS.routingState) {
      next.routingState = "default";
    } else if (key === POLICY_TAGS.bikeability) {
      next.bikeability = null;
    } else if (key === POLICY_TAGS.bicycleDirection) {
      next.bicycleDirection = "both";
    } else if (key === POLICY_TAGS.unavailableUntil || key === POLICY_TAGS.legacyAvailability) {
      next.unavailableUntil = null;
    }
  }
  for (const [key, value] of Object.entries(patch.set || {})) {
    if (key === POLICY_TAGS.routingState) {
      next.routingState = normalizeRoutingState(value);
    } else if (key === POLICY_TAGS.bikeability) {
      next.bikeability = normalizeBikeability(value);
    } else if (key === POLICY_TAGS.bicycleDirection) {
      next.bicycleDirection = normalizeBicycleDirection(value);
    } else if (key === POLICY_TAGS.unavailableUntil) {
      next.unavailableUntil = normalizeUnavailableUntil(value);
    } else if (key === POLICY_TAGS.legacyAvailability && value === "temporarily_unavailable") {
      next.unavailableUntil = "9999-12-31";
    }
  }
  return next;
}


export function normalizePatchset(rawPatchset) {
  const patchset = rawPatchset || emptyPatchset();
  const passthroughPatches = [];
  const policyByWayId = new Map();

  for (const patch of patchset.patches || []) {
    if (!isManagedPolicyPatch(patch)) {
      passthroughPatches.push(patch);
      continue;
    }
    const contigId = Number(patch.contig_id);
    const current = policyByWayId.get(contigId) || defaultWayPolicy();
    policyByWayId.set(contigId, applyManagedPatch(current, patch));
  }

  return {
    meta: { ...(patchset.meta || emptyPatchset().meta) },
    passthroughPatches,
    policyByWayId,
  };
}


export function policyForWay(editorState, wayId) {
  return editorState.policyByWayId.get(Number(wayId)) || defaultWayPolicy();
}


export function setWayPolicy(editorState, wayId, nextPolicy) {
  const normalized = {
    routingState: normalizeRoutingState(nextPolicy.routingState),
    bikeability: normalizeBikeability(nextPolicy.bikeability),
    bicycleDirection: normalizeBicycleDirection(nextPolicy.bicycleDirection),
    unavailableUntil: normalizeUnavailableUntil(nextPolicy.unavailableUntil),
  };
  if (
    normalized.routingState === "default" &&
    normalized.bikeability == null &&
    normalized.bicycleDirection === "both" &&
    normalized.unavailableUntil == null
  ) {
    editorState.policyByWayId.delete(Number(wayId));
    return;
  }
  editorState.policyByWayId.set(Number(wayId), normalized);
}


function managedPatchForWay(wayId, policy, nodeIds = []) {
  const set = {};
  if (policy.routingState !== "default") {
    set[POLICY_TAGS.routingState] = policy.routingState;
  }
  if (policy.bikeability != null) {
    set[POLICY_TAGS.bikeability] = String(policy.bikeability);
  }
  if (policy.bicycleDirection !== "both") {
    set[POLICY_TAGS.bicycleDirection] = policy.bicycleDirection;
  }
  if (policy.unavailableUntil != null) {
    set[POLICY_TAGS.unavailableUntil] = policy.unavailableUntil;
  }
  return {
    id: `editor-policy-contig-${wayId}`,
    op: "update_contig_tags",
    contig_id: Number(wayId),
    node_ids: [...nodeIds],
    set,
  };
}


export function buildPatchsetDocument(editorState, featureById = new Map()) {
  const patches = [...editorState.passthroughPatches];
  for (const [wayId, policy] of [...editorState.policyByWayId.entries()].sort((a, b) => a[0] - b[0])) {
    const feature = featureById.get(Number(wayId));
    const nodeIds = feature?.properties?.node_ids || [];
    patches.push(managedPatchForWay(wayId, policy, nodeIds));
  }
  return {
    meta: { ...editorState.meta },
    patches,
  };
}
