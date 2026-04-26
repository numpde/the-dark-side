import test from "node:test";
import assert from "node:assert/strict";

import {
  POLICY_TAGS,
  buildPatchsetDocument,
  defaultWayPolicy,
  emptyPatchset,
  normalizePatchset,
  policyForWay,
  setWayPolicy,
} from "../web/editor-state.mjs";


test("normalizePatchset extracts managed policy patches and preserves others", () => {
  const raw = {
    meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" },
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


test("normalizePatchset splits mixed contig tag patches into managed policy and passthrough tags", () => {
  const editorState = normalizePatchset({
    meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" },
    patches: [
      {
        id: "editor-policy-contig-55",
        op: "update_contig_tags",
        contig_id: 55,
        set: {
          [POLICY_TAGS.routingState]: "exclude",
          "surface": "gravel",
        },
        remove: [POLICY_TAGS.bikeability, "name"],
      },
    ],
  });

  assert.deepEqual(policyForWay(editorState, 55), {
    routingState: "exclude",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  });
  assert.deepEqual(editorState.passthroughPatches, [
    {
      id: "editor-policy-contig-55--passthrough",
      op: "update_contig_tags",
      contig_id: 55,
      set: {
        surface: "gravel",
      },
      remove: ["name"],
    },
  ]);

  const doc = buildPatchsetDocument(editorState, new Map([
    [
      55,
      {
        properties: {
          node_ids: [550, 551],
        },
      },
    ],
  ]));
  assert.deepEqual(doc.patches, [
    {
      id: "editor-policy-contig-55--passthrough",
      op: "update_contig_tags",
      contig_id: 55,
      set: {
        surface: "gravel",
      },
      remove: ["name"],
    },
    {
      id: "editor-policy-contig-55",
      op: "update_contig_tags",
      contig_id: 55,
      node_ids: [550, 551],
      set: {
        [POLICY_TAGS.routingState]: "exclude",
      },
    },
  ]);
});


test("setWayPolicy removes default policy from managed state", () => {
  const editorState = normalizePatchset(emptyPatchset());
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
    meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" },
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

  const doc = buildPatchsetDocument(editorState, new Map([
    [
      42,
      {
        properties: {
          node_ids: [420, 421],
        },
      },
    ],
  ]));
  assert.equal(doc.patches.length, 2);
  assert.equal(doc.patches[0].id, "passthrough");
  assert.deepEqual(doc.patches[1], {
    id: "editor-policy-contig-42",
    op: "update_contig_tags",
    contig_id: 42,
    node_ids: [420, 421],
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
    meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" },
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

test("normalizePatchset rejects malformed patchset documents instead of treating them as empty", () => {
  assert.throws(
    () => normalizePatchset({ meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" } }),
    /Patchset must contain a patches array/
  );
  assert.throws(
    () => normalizePatchset([]),
    /Patchset must be a JSON object/
  );
  assert.throws(
    () => normalizePatchset({ meta: {}, patches: [] }),
    /Patchset meta\.asset_kind must be a non-empty string/
  );
  assert.deepEqual(normalizePatchset(emptyPatchset()).passthroughPatches, []);
});


test("normalizePatchset rejects malformed managed contig tag patch shapes", () => {
  assert.throws(
    () => normalizePatchset({
      meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" },
      patches: [
        {
          id: "editor-policy-contig-12",
          op: "update_contig_tags",
          contig_id: 12,
          set: ["not", "an", "object"],
        },
      ],
    }),
    /set must be an object/
  );
  assert.throws(
    () => normalizePatchset({
      meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" },
      patches: [
        {
          id: "editor-policy-contig-13",
          op: "update_contig_tags",
          contig_id: 13,
          remove: "local:routing_state",
        },
      ],
    }),
    /remove must be an array of strings/
  );
});


test("normalizePatchset migrates legacy temporary unavailability to far-future unavailable-until", () => {
  const editorState = normalizePatchset({
    meta: { asset_kind: "map_patchset", patchset_id: "karura-map-patches-v1" },
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
  const editorState = normalizePatchset(emptyPatchset());
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

test("buildPatchsetDocument rejects managed policies for contigs missing from the current graph", () => {
  const editorState = normalizePatchset(emptyPatchset());
  setWayPolicy(editorState, 404, { routingState: "exclude" });

  assert.throws(
    () => buildPatchsetDocument(editorState, new Map()),
    /Current graph is missing contig 404; rebuild editor assets before exporting patches/
  );
});
