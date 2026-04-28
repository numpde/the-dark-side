import * as editorPolicyContracts from "./editor-policy-contracts.mjs";

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


export function emptyRoutePolicyDocument() {
  return {
    meta: {
      asset_kind: "route_policy",
      asset_id: "karura-route-policy-v1",
      description: "Canonical route policy on patched-map paths, projected onto the current graph during rebuild.",
    },
    rules: [],
  };
}


export const emptyPatchset = emptyRoutePolicyDocument;


function isBufferZoneFeature(feature) {
  return feature?.properties?.tags?.["local:boundary_zone"] === "buffer";
}


function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}


function requireIntegerArray(value, label, { minLength = 0 } = {}) {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(Number(item)))) {
    throw new Error(`${label} must be an array of integers`);
  }
  if (value.length < minLength) {
    throw new Error(`${label} must contain at least ${minLength} items`);
  }
  return value.map((item) => Number(item));
}


function requireRoutePolicyDocument(rawDocument) {
  if (!rawDocument || typeof rawDocument !== "object" || Array.isArray(rawDocument)) {
    throw new Error("Route policy must be a JSON object");
  }
  const meta = requirePlainObject(rawDocument.meta, "Route policy meta");
  if (typeof meta.asset_kind !== "string" || meta.asset_kind.length === 0) {
    throw new Error("Route policy meta.asset_kind must be a non-empty string");
  }
  if (typeof meta.asset_id !== "string" || meta.asset_id.length === 0) {
    throw new Error("Route policy meta.asset_id must be a non-empty string");
  }
  if (!Array.isArray(rawDocument.rules)) {
    throw new Error("Route policy must contain a rules array");
  }
  return rawDocument;
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


function splitManagedPatch(patch) {
  if (
    !patch ||
    patch.enabled === false ||
    patch.op !== "update_contig_tags" ||
    !Number.isInteger(Number(patch.contig_id))
  ) {
    throw new Error(`Legacy route policy import only supports enabled update_contig_tags patches; found ${patch?.op ?? "(unknown)"}`);
  }

  validateManagedPatchShape(patch);

  const managedNames = managedTagNames();
  const patchSet = patch.set ?? {};
  const patchRemove = patch.remove ?? [];

  const unsupportedSet = Object.keys(patchSet).filter((key) => !managedNames.has(key));
  const unsupportedRemove = patchRemove.filter((key) => !managedNames.has(key));
  if (unsupportedSet.length > 0 || unsupportedRemove.length > 0) {
    throw new Error(`Legacy patch ${patch.id || "(unnamed)"} contains unsupported non-policy tags`);
  }

  return patch;
}


function applyLegacyManagedPatch(policy, patch) {
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


function normalizeSelector(selector, label) {
  const normalizedSelector = requirePlainObject(selector, `${label} selector`);
  return {
    way_ids: requireIntegerArray(normalizedSelector.way_ids, `${label} selector.way_ids`, { minLength: 1 }),
    node_ids: requireIntegerArray(normalizedSelector.node_ids, `${label} selector.node_ids`, { minLength: 2 }),
  };
}


function normalizePolicyObject(policy, label) {
  const normalizedPolicy = requirePlainObject(policy, `${label} policy`);
  const next = defaultWayPolicy();
  let seen = 0;
  for (const [key, value] of Object.entries(normalizedPolicy)) {
    if (key === "routing_state") {
      next.routingState = requireRoutingState(value, `${label} policy.routing_state`);
      seen += 1;
    } else if (key === "bikeability") {
      next.bikeability = requireBikeability(value, `${label} policy.bikeability`);
      seen += 1;
    } else if (key === "bicycle_direction") {
      next.bicycleDirection = requireBicycleDirection(value, `${label} policy.bicycle_direction`);
      seen += 1;
    } else if (key === "unavailable_until") {
      next.unavailableUntil = requireUnavailableUntil(value, `${label} policy.unavailable_until`);
      seen += 1;
    } else {
      throw new Error(`${label} policy contains unsupported field ${key}`);
    }
  }
  if (seen === 0) {
    throw new Error(`${label} policy must contain at least one policy field`);
  }
  return next;
}


function featureSelector(feature) {
  const wayIds = requireIntegerArray(feature?.properties?.way_ids, "Contig feature way_ids", { minLength: 1 });
  const nodeIds = requireIntegerArray(feature?.properties?.node_ids, "Contig feature node_ids", { minLength: 2 });
  return {
    way_ids: wayIds,
    node_ids: nodeIds,
  };
}


function featureContigId(feature) {
  return Number(feature?.properties?.contig_id);
}


function normalizeWayIds(wayIds) {
  return [...wayIds].map((value) => Number(value)).sort((a, b) => a - b);
}


function selectorEdgeKeys(selector) {
  const keys = [];
  for (let index = 0; index < selector.node_ids.length - 1; index += 1) {
    const firstId = Number(selector.node_ids[index]);
    const secondId = Number(selector.node_ids[index + 1]);
    const key = firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
    keys.push(key);
  }
  return keys;
}


function buildFeatureLookupByEdge(featureById) {
  const byEdge = new Map();
  for (const feature of featureById.values()) {
    const selector = featureSelector(feature);
    for (const key of selectorEdgeKeys(selector)) {
      if (!byEdge.has(key)) {
        byEdge.set(key, []);
      }
      byEdge.get(key).push(feature);
    }
  }
  return byEdge;
}


function selectorWayIdSet(selector) {
  return new Set(normalizeWayIds(selector.way_ids));
}


function selectorsShareWayIds(leftSelector, rightSelector) {
  const leftWayIds = selectorWayIdSet(leftSelector);
  return normalizeWayIds(rightSelector.way_ids).some((wayId) => leftWayIds.has(wayId));
}


function resolveFeaturesForSelector(selector, featureById, label) {
  const byEdge = buildFeatureLookupByEdge(featureById);
  const matches = [];
  let previousContigId = null;
  for (const key of selectorEdgeKeys(selector)) {
    const candidateFeatures = (byEdge.get(key) ?? [])
      .filter((feature) => selectorsShareWayIds(selector, featureSelector(feature)));
    if (candidateFeatures.length === 0) {
      throw new Error(`${label} selector no longer matches the current graph`);
    }
    if (candidateFeatures.length > 1) {
      throw new Error(`${label} selector matches multiple current contigs`);
    }
    const feature = candidateFeatures[0];
    const contigId = featureContigId(feature);
    if (previousContigId === contigId) {
      continue;
    }
    matches.push(feature);
    previousContigId = contigId;
  }
  return matches;
}


function resolveFeatureForSelector(selector, featureById, label) {
  const targetForward = JSON.stringify(selector.node_ids);
  const targetReverse = JSON.stringify([...selector.node_ids].reverse());
  const targetWayIds = JSON.stringify(normalizeWayIds(selector.way_ids));
  const matches = [];
  for (const feature of featureById.values()) {
    const featureResolvedSelector = featureSelector(feature);
    const signature = JSON.stringify(featureResolvedSelector.node_ids);
    if (signature !== targetForward && signature !== targetReverse) {
      continue;
    }
    if (JSON.stringify(normalizeWayIds(featureResolvedSelector.way_ids)) !== targetWayIds) {
      continue;
    }
    matches.push(feature);
  }
  if (matches.length === 0) {
    throw new Error(`${label} selector no longer matches the current graph`);
  }
  if (matches.length > 1) {
    throw new Error(`${label} selector matches multiple current contigs`);
  }
  return matches[0];
}


function routePolicyRuleFromLegacyPatch(patch, featureById) {
  const managedPatch = splitManagedPatch(patch);
  const nodeIds = requireIntegerArray(managedPatch.node_ids, `Patch ${patch.id || "(unnamed)"} node_ids`, { minLength: 2 });
  const tempFeature = resolveFeatureForSelector(
    { way_ids: featureWayIdsForNodeSignature(nodeIds, featureById), node_ids: nodeIds },
    featureById,
    `Patch ${patch.id || "(unnamed)"}`
  );
  const selector = featureSelector(tempFeature);
  return {
    id: generatedRuleIdForSelector(selector),
    selector,
    policy: compactPolicy(applyLegacyManagedPatch(defaultWayPolicy(), managedPatch)),
  };
}


function featureWayIdsForNodeSignature(nodeIds, featureById) {
  const matches = [];
  for (const feature of featureById.values()) {
    const selector = featureSelector(feature);
    const signature = JSON.stringify(selector.node_ids);
    const reversed = JSON.stringify([...selector.node_ids].reverse());
    const target = JSON.stringify(nodeIds);
    if (signature === target || reversed === target) {
      matches.push(selector.way_ids);
    }
  }
  if (matches.length > 1) {
    throw new Error(`Legacy patch selector matches multiple current contigs`);
  }
  if (matches.length === 1) {
    return matches[0];
  }
  throw new Error(`Legacy patch selector no longer matches the current graph`);
}


function compactPolicy(policy) {
  const compact = {};
  if (policy.routingState !== "default") {
    compact.routing_state = policy.routingState;
  }
  if (policy.bikeability != null) {
    compact.bikeability = policy.bikeability;
  }
  if (policy.bicycleDirection !== "both") {
    compact.bicycle_direction = policy.bicycleDirection;
  }
  if (policy.unavailableUntil != null) {
    compact.unavailable_until = policy.unavailableUntil;
  }
  return compact;
}


function mergePolicies(basePolicy, explicitPolicy) {
  const merged = { ...basePolicy };
  if (explicitPolicy.routingState !== "default") {
    merged.routingState = explicitPolicy.routingState;
  }
  if (explicitPolicy.bikeability != null) {
    merged.bikeability = explicitPolicy.bikeability;
  }
  if (explicitPolicy.bicycleDirection !== "both") {
    merged.bicycleDirection = explicitPolicy.bicycleDirection;
  }
  if (explicitPolicy.unavailableUntil != null) {
    merged.unavailableUntil = explicitPolicy.unavailableUntil;
  }
  return merged;
}


export function basePolicyForFeature(feature) {
  const base = defaultWayPolicy();
  if (isBufferZoneFeature(feature)) {
    base.routingState = "exclude";
  }
  return base;
}


function explicitPolicyFromEffective(policy, basePolicy) {
  return {
    routingState: policy.routingState === basePolicy.routingState ? "default" : policy.routingState,
    bikeability: policy.bikeability === basePolicy.bikeability ? null : policy.bikeability,
    bicycleDirection: policy.bicycleDirection === basePolicy.bicycleDirection ? "both" : policy.bicycleDirection,
    unavailableUntil: policy.unavailableUntil === basePolicy.unavailableUntil ? null : policy.unavailableUntil,
  };
}


function isDefaultPolicy(policy) {
  return (
    policy.routingState === "default" &&
    policy.bikeability == null &&
    policy.bicycleDirection === "both" &&
    policy.unavailableUntil == null
  );
}


function hashSelector(selector) {
  const text = JSON.stringify({
    way_ids: normalizeWayIds(selector.way_ids),
    node_ids: selector.node_ids.map((value) => Number(value)),
  });
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}


function generatedRuleIdForSelector(selector) {
  return `route-policy-path-${hashSelector(selector)}`;
}

function policiesEqual(left, right) {
  return JSON.stringify(compactPolicy(left)) === JSON.stringify(compactPolicy(right));
}


function buildRulesFromDocument(rawDocument, featureById) {
  const meta = rawDocument.meta;
  if (meta.asset_kind === "route_policy") {
    return rawDocument.rules.map((rule, index) => ({
      id: String(rule.id),
      selector: normalizeSelector(rule.selector, `Rule ${rule.id || index}`),
      policy: normalizePolicyObject(rule.policy, `Rule ${rule.id || index}`),
    }));
  }
  if (meta.asset_kind === "map_patchset") {
    if (!Array.isArray(rawDocument.patches)) {
      throw new Error("Patchset must contain a patches array");
    }
    return rawDocument.patches.map((patch) => routePolicyRuleFromLegacyPatch(patch, featureById));
  }
  throw new Error(`Unsupported editor policy document asset kind ${meta.asset_kind}`);
}

function resolveMatchesForSelector(selector, featureById, label) {
  const byEdge = buildFeatureLookupByEdge(featureById);
  const matches = [];
  let previousContigId = null;
  let currentMatch = null;
  for (const [edgeIndex, key] of selectorEdgeKeys(selector).entries()) {
    const candidateFeatures = (byEdge.get(key) ?? [])
      .filter((feature) => selectorsShareWayIds(selector, featureSelector(feature)));
    if (candidateFeatures.length === 0) {
      throw new Error(`${label} selector no longer matches the current graph`);
    }
    if (candidateFeatures.length > 1) {
      throw new Error(`${label} selector matches multiple current contigs`);
    }
    const feature = candidateFeatures[0];
    const contigId = featureContigId(feature);
    if (previousContigId === contigId && currentMatch) {
      currentMatch.endEdgeIndex = edgeIndex;
      continue;
    }
    currentMatch = {
      contigId,
      feature,
      startEdgeIndex: edgeIndex,
      endEdgeIndex: edgeIndex,
    };
    matches.push(currentMatch);
    previousContigId = contigId;
  }
  return matches;
}


function normalizeExportedRule(rule) {
  return {
    id: String(rule.id),
    selector: {
      way_ids: [...rule.selector.way_ids].map((value) => Number(value)),
      node_ids: [...rule.selector.node_ids].map((value) => Number(value)),
    },
    policy: compactPolicy(rule.policy),
  };
}


function selectorForContigRun(loadedRule, matches, startIndex, endIndex, featureById) {
  if (startIndex === 0 && endIndex === matches.length - 1) {
    return {
      way_ids: [...loadedRule.selector.way_ids],
      node_ids: [...loadedRule.selector.node_ids],
    };
  }
  const startEdgeIndex = matches[startIndex].startEdgeIndex;
  const endEdgeIndex = matches[endIndex].endEdgeIndex;
  const node_ids = loadedRule.selector.node_ids.slice(startEdgeIndex, endEdgeIndex + 2);
  const way_ids = [];
  const seenWayIds = new Set();
  for (let matchIndex = startIndex; matchIndex <= endIndex; matchIndex += 1) {
    const feature = featureById.get(matches[matchIndex].contigId);
    if (!feature) {
      throw new Error(
        `Current graph is missing contig ${matches[matchIndex].contigId}; rebuild editor assets before exporting route policy`
      );
    }
    for (const wayId of featureSelector(feature).way_ids) {
      if (seenWayIds.has(wayId)) {
        continue;
      }
      seenWayIds.add(wayId);
      way_ids.push(wayId);
    }
  }
  return { way_ids, node_ids };
}


function currentExplicitPolicy(editorState, contigId) {
  return editorState.policyByContigId.get(Number(contigId)) || defaultWayPolicy();
}


function countDocumentChanges(baselineDocument, nextDocument) {
  const baselineById = new Map(
    baselineDocument.rules.map((rule) => [String(rule.id), JSON.stringify(rule)]),
  );
  const nextById = new Map(
    nextDocument.rules.map((rule) => [String(rule.id), JSON.stringify(rule)]),
  );
  let changed = 0;
  for (const ruleId of new Set([...baselineById.keys(), ...nextById.keys()])) {
    if (baselineById.get(ruleId) !== nextById.get(ruleId)) {
      changed += 1;
    }
  }
  return changed;
}


export function normalizeRoutePolicyDocument(rawDocument, featureById = new Map()) {
  const document = requireRoutePolicyDocument(
    rawDocument?.meta?.asset_kind === "route_policy"
      ? rawDocument
      : rawDocument?.meta?.asset_kind === "map_patchset"
        ? {
            meta: {
              asset_kind: "route_policy",
              asset_id: rawDocument.meta.patchset_id || "migrated-route-policy",
              description: "Migrated from legacy contig tag patchset.",
            },
            rules: buildRulesFromDocument(rawDocument, featureById),
          }
        : rawDocument
  );

  const policyByContigId = new Map();
  const loadedRuleIdByContigId = new Map();
  const ruleIdByContigId = new Map();
  const loadedRules = buildRulesFromDocument(document, featureById);
  const loadedRuleMatchesById = new Map();
  for (const rule of loadedRules) {
    const matches = resolveMatchesForSelector(rule.selector, featureById, `Rule ${rule.id}`);
    loadedRuleMatchesById.set(rule.id, matches.map((match) => ({
      contigId: match.contigId,
      startEdgeIndex: match.startEdgeIndex,
      endEdgeIndex: match.endEdgeIndex,
    })));
    for (const match of matches) {
      const contigId = match.contigId;
      if (policyByContigId.has(contigId)) {
        throw new Error(`Multiple route policy rules resolve to contig ${contigId}`);
      }
      policyByContigId.set(contigId, rule.policy);
      loadedRuleIdByContigId.set(contigId, rule.id);
      ruleIdByContigId.set(contigId, rule.id);
    }
  }

  return {
    meta: { ...document.meta },
    featureByContigId: new Map(featureById),
    loadedDocument: {
      meta: { ...document.meta },
      rules: loadedRules.map(normalizeExportedRule),
    },
    loadedRules,
    loadedRuleIdByContigId,
    loadedRuleMatchesById,
    policyByContigId,
    ruleIdByContigId,
  };
}


export const normalizePatchset = normalizeRoutePolicyDocument;


export function policyForContig(editorState, contigId) {
  const contigKey = Number(contigId);
  const explicitPolicy = currentExplicitPolicy(editorState, contigKey);
  const feature = editorState.featureByContigId?.get(contigKey);
  return mergePolicies(basePolicyForFeature(feature), explicitPolicy);
}


export function explicitPolicyForContig(editorState, contigId) {
  return editorState.policyByContigId.get(Number(contigId)) || defaultWayPolicy();
}


export function setContigPolicy(editorState, contigId, nextPolicy) {
  const contigKey = Number(contigId);
  const basePolicy = basePolicyForFeature(editorState.featureByContigId?.get(contigKey));
  const normalized = {
    routingState: normalizeRoutingState(nextPolicy.routingState),
    bikeability: normalizeBikeability(nextPolicy.bikeability),
    bicycleDirection: normalizeBicycleDirection(nextPolicy.bicycleDirection),
    unavailableUntil: normalizeUnavailableUntil(nextPolicy.unavailableUntil),
  };
  const explicitPolicy = explicitPolicyFromEffective(normalized, basePolicy);
  if (isDefaultPolicy(explicitPolicy)) {
    editorState.policyByContigId.delete(contigKey);
    if (editorState.loadedRuleIdByContigId?.has(contigKey)) {
      editorState.ruleIdByContigId.set(contigKey, editorState.loadedRuleIdByContigId.get(contigKey));
    } else {
      editorState.ruleIdByContigId.delete(contigKey);
    }
    return;
  }
  editorState.policyByContigId.set(contigKey, explicitPolicy);
  if (!editorState.loadedRuleIdByContigId?.has(contigKey)) {
    const feature = editorState.featureByContigId?.get(contigKey);
    if (feature) {
      editorState.ruleIdByContigId.set(contigKey, generatedRuleIdForSelector(featureSelector(feature)));
    }
  }
}


export function buildRoutePolicyDocument(editorState, featureById = new Map()) {
  const rules = [];
  const emittedContigIds = new Set();
  for (const loadedRule of editorState.loadedRules ?? []) {
    const matches = editorState.loadedRuleMatchesById?.get(loadedRule.id) ?? [];
    let run = null;
    const flushRun = () => {
      if (!run || isDefaultPolicy(run.policy)) {
        run = null;
        return;
      }
      const selector = selectorForContigRun(loadedRule, matches, run.startIndex, run.endIndex, featureById);
      const preservesOriginalRule =
        run.startIndex === 0 &&
        run.endIndex === matches.length - 1 &&
        policiesEqual(run.policy, loadedRule.policy);
      rules.push({
        id: preservesOriginalRule ? loadedRule.id : generatedRuleIdForSelector(selector),
        selector,
        policy: compactPolicy(run.policy),
      });
      run = null;
    };
    matches.forEach((match, matchIndex) => {
      emittedContigIds.add(match.contigId);
      const explicitPolicy = currentExplicitPolicy(editorState, match.contigId);
      if (!run) {
        run = {
          startIndex: matchIndex,
          endIndex: matchIndex,
          policy: explicitPolicy,
        };
        return;
      }
      if (policiesEqual(run.policy, explicitPolicy)) {
        run.endIndex = matchIndex;
        return;
      }
      flushRun();
      run = {
        startIndex: matchIndex,
        endIndex: matchIndex,
        policy: explicitPolicy,
      };
    });
    flushRun();
  }
  for (const [contigId, policy] of [...editorState.policyByContigId.entries()].sort((a, b) => a[0] - b[0])) {
    if (emittedContigIds.has(Number(contigId))) {
      continue;
    }
    const feature = featureById.get(Number(contigId));
    if (!feature) {
      throw new Error(`Current graph is missing contig ${contigId}; rebuild editor assets before exporting route policy`);
    }
    const selector = featureSelector(feature);
    rules.push({
      id: editorState.ruleIdByContigId.get(Number(contigId)) || generatedRuleIdForSelector(selector),
      selector,
      policy: compactPolicy(policy),
    });
  }
  return {
    meta: { ...editorState.meta },
    rules,
  };
}


export const buildPatchsetDocument = buildRoutePolicyDocument;


export function countRoutePolicyChanges(editorState, featureById = new Map()) {
  return countDocumentChanges(
    editorState.loadedDocument ?? emptyRoutePolicyDocument(),
    buildRoutePolicyDocument(editorState, featureById),
  );
}
