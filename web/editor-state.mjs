const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Editor state module");
const editorPolicyContracts = await import(`./editor-policy-contracts.mjs${moduleSuffix}`);

export const {
  POLICY_TAGS,
  defaultWayPolicy,
  normalizeRoutingState,
  requireRoutingState,
  normalizeBikeability,
  requireBikeability,
  normalizeBicycleDirection,
  requireBicycleDirection,
  normalizeUnavailableUntil,
  requireUnavailableUntil,
} = editorPolicyContracts;


export function emptyPatchset() {
  return {
    meta: {
      asset_kind: "map_patchset",
      patchset_id: "karura-map-patches-v1",
    },
    patches: [],
  };
}

function requirePatchsetObject(rawPatchset) {
  if (!rawPatchset || typeof rawPatchset !== "object" || Array.isArray(rawPatchset)) {
    throw new Error("Patchset must be a JSON object");
  }
  if (!Array.isArray(rawPatchset.patches)) {
    throw new Error("Patchset must contain a patches array");
  }
  const meta = requirePlainObject(rawPatchset.meta, "Patchset meta");
  if (typeof meta.asset_kind !== "string" || meta.asset_kind.length === 0) {
    throw new Error("Patchset meta.asset_kind must be a non-empty string");
  }
  if (typeof meta.patchset_id !== "string" || meta.patchset_id.length === 0) {
    throw new Error("Patchset meta.patchset_id must be a non-empty string");
  }
  return rawPatchset;
}


function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}


function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}


function validateManagedPatchShape(patch) {
  if (patch.set != null) {
    requirePlainObject(patch.set, `Patch ${patch.id || "(unnamed)"} set`);
  }
  if (patch.remove != null) {
    requireStringArray(patch.remove, `Patch ${patch.id || "(unnamed)"} remove`);
  }
}


function managedTagNames() {
  return new Set(Object.values(POLICY_TAGS));
}


function managedTagNamesSet() {
  return managedTagNames();
}


function splitManagedPatch(patch) {
  if (
    !patch ||
    patch.enabled === false ||
    patch.op !== "update_contig_tags" ||
    !Number.isInteger(Number(patch.contig_id))
  ) {
    return { managedPatch: null, residualPatch: patch ?? null };
  }

  validateManagedPatchShape(patch);

  const managedNames = managedTagNamesSet();
  const managedSet = {};
  const residualSet = {};
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (managedNames.has(key)) {
      managedSet[key] = value;
    } else {
      residualSet[key] = value;
    }
  }

  const managedRemove = [];
  const residualRemove = [];
  for (const key of patch.remove ?? []) {
    if (managedNames.has(key)) {
      managedRemove.push(key);
    } else {
      residualRemove.push(key);
    }
  }

  const managedHasContent = Object.keys(managedSet).length > 0 || managedRemove.length > 0;
  const residualHasContent = Object.keys(residualSet).length > 0 || residualRemove.length > 0;

  let residualPatch = null;
  if (residualHasContent) {
    residualPatch = {
      ...patch,
      ...(Object.keys(residualSet).length > 0 ? { set: residualSet } : { set: undefined }),
      ...(residualRemove.length > 0 ? { remove: residualRemove } : { remove: undefined }),
    };
    if (residualPatch.id === `editor-policy-contig-${Number(patch.contig_id)}`) {
      residualPatch.id = `${residualPatch.id}--passthrough`;
    }
    if (residualPatch.set === undefined) {
      delete residualPatch.set;
    }
    if (residualPatch.remove === undefined) {
      delete residualPatch.remove;
    }
  }

  return {
    managedPatch: managedHasContent
      ? {
          ...patch,
          ...(Object.keys(managedSet).length > 0 ? { set: managedSet } : { set: undefined }),
          ...(managedRemove.length > 0 ? { remove: managedRemove } : { remove: undefined }),
        }
      : null,
    residualPatch,
  };
}


function applyManagedPatch(policy, patch) {
  const next = { ...policy };
  for (const key of patch.remove ?? []) {
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
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (key === POLICY_TAGS.routingState) {
      next.routingState = requireRoutingState(value, `Patch ${patch.id || "(unnamed)"} ${POLICY_TAGS.routingState}`);
    } else if (key === POLICY_TAGS.bikeability) {
      next.bikeability = requireBikeability(value, `Patch ${patch.id || "(unnamed)"} ${POLICY_TAGS.bikeability}`);
    } else if (key === POLICY_TAGS.bicycleDirection) {
      next.bicycleDirection = requireBicycleDirection(
        value,
        `Patch ${patch.id || "(unnamed)"} ${POLICY_TAGS.bicycleDirection}`
      );
    } else if (key === POLICY_TAGS.unavailableUntil) {
      next.unavailableUntil = requireUnavailableUntil(
        value,
        `Patch ${patch.id || "(unnamed)"} ${POLICY_TAGS.unavailableUntil}`
      );
    } else if (key === POLICY_TAGS.legacyAvailability && value === "temporarily_unavailable") {
      next.unavailableUntil = "9999-12-31";
    } else if (key === POLICY_TAGS.legacyAvailability) {
      throw new Error(
        `Patch ${patch.id || "(unnamed)"} ${POLICY_TAGS.legacyAvailability} must be "temporarily_unavailable"`
      );
    }
  }
  return next;
}


export function normalizePatchset(rawPatchset) {
  const patchset = requirePatchsetObject(rawPatchset);
  const passthroughPatches = [];
  const policyByWayId = new Map();

  for (const patch of patchset.patches) {
    const { managedPatch, residualPatch } = splitManagedPatch(patch);
    if (residualPatch) {
      passthroughPatches.push(residualPatch);
    }
    if (!managedPatch) {
      continue;
    }
    const contigId = Number(managedPatch.contig_id);
    const current = policyByWayId.get(contigId) || defaultWayPolicy();
    policyByWayId.set(contigId, applyManagedPatch(current, managedPatch));
  }

  return {
    meta: { ...patchset.meta },
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
    if (!feature) {
      throw new Error(`Current graph is missing contig ${wayId}; rebuild editor assets before exporting patches`);
    }
    const nodeIds = feature.properties?.node_ids;
    if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
      throw new Error(`Contig ${wayId} is missing a valid node_ids signature; rebuild editor assets before exporting patches`);
    }
    patches.push(managedPatchForWay(wayId, policy, nodeIds));
  }
  return {
    meta: { ...editorState.meta },
    patches,
  };
}
