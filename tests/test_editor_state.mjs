import test from "node:test";
import assert from "node:assert/strict";

import {
  POLICY_TAGS,
  buildPatchsetDocument,
  defaultWayPolicy,
  normalizePatchset,
  policyForWay,
  setWayPolicy,
} from "../web/editor-state.mjs";


test("normalizePatchset extracts managed policy patches and preserves others", () => {
  const raw = {
    meta: { patchset_id: "karura-map-patches-v1" },
    patches: [
      {
        id: "editor-policy-contig-10",
        op: "update_contig_tags",
        contig_id: 10,
        set: {
          [POLICY_TAGS.routingState]: "exclude",
          [POLICY_TAGS.bikeability]: "2",
        },
      },
      {
        id: "unknown-geometry",
        op: "replace_way_geometry",
        way_id: 99,
        node_ids: [1, 2],
        nodes: [],
      },
    ],
  };

  const editorState = normalizePatchset(raw);
  assert.equal(editorState.passthroughPatches.length, 1);
  assert.equal(editorState.passthroughPatches[0].id, "unknown-geometry");
  assert.deepEqual(policyForWay(editorState, 10), {
    routingState: "exclude",
    bikeability: 2,
    bicycleDirection: "both",
    unavailableUntil: null,
  });
});


test("setWayPolicy removes default policy from managed state", () => {
  const editorState = normalizePatchset({ meta: {}, patches: [] });
  setWayPolicy(editorState, 11, {
    routingState: "include",
    bikeability: 4,
    bicycleDirection: "forward",
    unavailableUntil: "2026-05-10",
  });
  assert.notDeepEqual(policyForWay(editorState, 11), defaultWayPolicy());
  setWayPolicy(editorState, 11, defaultWayPolicy());
  assert.deepEqual(policyForWay(editorState, 11), defaultWayPolicy());
});


test("buildPatchsetDocument preserves passthrough patches and emits canonical policy patch", () => {
  const editorState = normalizePatchset({
    meta: { patchset_id: "karura-map-patches-v1" },
    patches: [
      {
        id: "passthrough",
        op: "add_way",
        way_id: -1,
        node_ids: [1, 2],
        nodes: [],
        tags: { highway: "path" },
      },
    ],
  });
  setWayPolicy(editorState, 42, {
    routingState: "include",
    bikeability: 5,
    bicycleDirection: "backward",
    unavailableUntil: "2026-05-10",
  });

  const doc = buildPatchsetDocument(editorState);
  assert.equal(doc.patches.length, 2);
  assert.equal(doc.patches[0].id, "passthrough");
  assert.deepEqual(doc.patches[1], {
    id: "editor-policy-contig-42",
    op: "update_contig_tags",
    contig_id: 42,
    node_ids: [],
    set: {
      [POLICY_TAGS.routingState]: "include",
      [POLICY_TAGS.bikeability]: "5",
      [POLICY_TAGS.bicycleDirection]: "backward",
      [POLICY_TAGS.unavailableUntil]: "2026-05-10",
    },
  });
});


test("normalizePatchset sanitizes invalid managed policy values", () => {
  const editorState = normalizePatchset({
    meta: { patchset_id: "karura-map-patches-v1" },
    patches: [
      {
        id: "editor-policy-contig-77",
        op: "update_contig_tags",
        contig_id: 77,
        set: {
          [POLICY_TAGS.routingState]: "sideways",
          [POLICY_TAGS.bikeability]: "99",
          [POLICY_TAGS.bicycleDirection]: "uphill-only",
          [POLICY_TAGS.unavailableUntil]: "soon",
        },
      },
    ],
  });

  assert.deepEqual(policyForWay(editorState, 77), defaultWayPolicy());
});


test("normalizePatchset migrates legacy temporary unavailability to far-future unavailable-until", () => {
  const editorState = normalizePatchset({
    meta: { patchset_id: "karura-map-patches-v1" },
    patches: [
      {
        id: "editor-policy-contig-88",
        op: "update_contig_tags",
        contig_id: 88,
        set: {
          [POLICY_TAGS.legacyAvailability]: "temporarily_unavailable",
        },
      },
    ],
  });

  assert.deepEqual(policyForWay(editorState, 88), {
    routingState: "default",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: "9999-12-31",
  });
});


test("buildPatchsetDocument includes contig node ids when available", () => {
  const editorState = normalizePatchset({ meta: {}, patches: [] });
  setWayPolicy(editorState, 9, { routingState: "exclude" });
  const featureById = new Map([
    [
      9,
      {
        properties: {
          node_ids: [100, 101, 102],
        },
      },
    ],
  ]);

  const doc = buildPatchsetDocument(editorState, featureById);
  assert.deepEqual(doc.patches[0], {
    id: "editor-policy-contig-9",
    op: "update_contig_tags",
    contig_id: 9,
    node_ids: [100, 101, 102],
    set: {
      [POLICY_TAGS.routingState]: "exclude",
    },
  });
});
