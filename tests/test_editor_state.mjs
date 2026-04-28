import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const frontendManifest = JSON.parse(
  fs.readFileSync(new URL("../web/generated/frontend-manifest.json", import.meta.url), "utf8")
);
const editorVersion = frontendManifest.modules.editor_version;
const {
  POLICY_TAGS,
  buildRoutePolicyDocument,
  countRoutePolicyChanges,
  defaultWayPolicy,
  emptyRoutePolicyDocument,
  normalizeRoutePolicyDocument,
  policyForContig,
  setContigPolicy,
} = await import(`../web/editor-state.mjs?v=${encodeURIComponent(editorVersion)}`);

function feature(contigId, wayIds, nodeIds, tags = {}) {
  return {
    properties: {
      contig_id: contigId,
      way_ids: wayIds,
      node_ids: nodeIds,
      tags,
    },
  };
}

function featureMap(...features) {
  return new Map(features.map((item) => [item.properties.contig_id, item]));
}

test("normalizeRoutePolicyDocument resolves rules onto the current graph", () => {
  const features = featureMap(
    feature(42, [1001], [420, 421, 422]),
    feature(77, [2001, 2002], [770, 771]),
  );
  const editorState = normalizeRoutePolicyDocument(
    {
      meta: {
        asset_kind: "route_policy",
        asset_id: "karura-route-policy-v1",
      },
      rules: [
        {
          id: "rule-42",
          selector: { way_ids: [1001], node_ids: [420, 421, 422] },
          policy: { routing_state: "exclude", bikeability: 2 },
        },
        {
          id: "rule-77",
          selector: { way_ids: [2001, 2002], node_ids: [770, 771] },
          policy: { bicycle_direction: "backward", unavailable_until: "2026-06-30" },
        },
      ],
    },
    features,
  );

  assert.equal(editorState.meta.asset_kind, "route_policy");
  assert.equal(editorState.ruleIdByContigId.get(42), "rule-42");
  assert.equal(editorState.ruleIdByContigId.get(77), "rule-77");
  assert.deepEqual(policyForContig(editorState, 42), {
    routingState: "exclude",
    bikeability: 2,
    bicycleDirection: "both",
    unavailableUntil: null,
  });
  assert.deepEqual(policyForContig(editorState, 77), {
    routingState: "default",
    bikeability: null,
    bicycleDirection: "backward",
    unavailableUntil: "2026-06-30",
  });
});

test("buildRoutePolicyDocument preserves selectors and emits compact policy fields", () => {
  const features = featureMap(feature(42, [1001], [420, 421, 422]));
  const editorState = normalizeRoutePolicyDocument(emptyRoutePolicyDocument());

  setContigPolicy(editorState, 42, {
    routingState: "include",
    bikeability: 5,
    bicycleDirection: "backward",
    unavailableUntil: "2026-05-10",
  });

  const document = buildRoutePolicyDocument(editorState, features);
  assert.deepEqual(document.meta, {
    asset_kind: "route_policy",
    asset_id: "karura-route-policy-v1",
    description: "Canonical route policy on patched-map paths, projected onto the current graph during rebuild.",
  });
  assert.equal(document.rules.length, 1);
  assert.match(document.rules[0].id, /^route-policy-path-[0-9a-f]{8}$/);
  assert.deepEqual(document.rules[0].selector, {
    way_ids: [1001],
    node_ids: [420, 421, 422],
  });
  assert.deepEqual(document.rules[0].policy, {
    routing_state: "include",
    bikeability: 5,
    bicycle_direction: "backward",
    unavailable_until: "2026-05-10",
  });
});

test("normalizeRoutePolicyDocument migrates legacy contig tag patchsets by node signature", () => {
  const features = featureMap(feature(55, [5501], [550, 551]));
  const editorState = normalizeRoutePolicyDocument(
    {
      meta: {
        asset_kind: "map_patchset",
        patchset_id: "legacy-policy",
      },
      patches: [
        {
          id: "editor-policy-contig-55",
          op: "update_contig_tags",
          contig_id: 999,
          node_ids: [550, 551],
          set: {
            [POLICY_TAGS.routingState]: "exclude",
            [POLICY_TAGS.bikeability]: "2",
            [POLICY_TAGS.unavailableUntil]: "2026-06-30",
          },
        },
      ],
    },
    features,
  );

  assert.equal(editorState.meta.asset_kind, "route_policy");
  assert.equal(editorState.meta.asset_id, "legacy-policy");
  assert.match(editorState.ruleIdByContigId.get(55), /^route-policy-path-[0-9a-f]{8}$/);
  assert.deepEqual(policyForContig(editorState, 55), {
    routingState: "exclude",
    bikeability: 2,
    bicycleDirection: "both",
    unavailableUntil: "2026-06-30",
  });
});

test("normalizeRoutePolicyDocument expands split selectors across multiple current contigs", () => {
  const features = featureMap(
    feature(10, [1001], [420, 421]),
    feature(11, [1001], [421, 422]),
  );
  const editorState = normalizeRoutePolicyDocument(
    {
      meta: {
        asset_kind: "route_policy",
        asset_id: "karura-route-policy-v1",
      },
      rules: [
        {
          id: "split-rule",
          selector: { way_ids: [1001], node_ids: [420, 421, 422] },
          policy: { routing_state: "exclude" },
        },
      ],
    },
    features,
  );

  assert.deepEqual(policyForContig(editorState, 10), {
    routingState: "exclude",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  });
  assert.deepEqual(policyForContig(editorState, 11), {
    routingState: "exclude",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  });
  assert.equal(editorState.ruleIdByContigId.get(10), "split-rule");
  assert.equal(editorState.ruleIdByContigId.get(11), "split-rule");
});

test("buildRoutePolicyDocument preserves split selectors without edits", () => {
  const features = featureMap(
    feature(10, [1001], [420, 421]),
    feature(11, [1001], [421, 422]),
  );
  const editorState = normalizeRoutePolicyDocument(
    {
      meta: {
        asset_kind: "route_policy",
        asset_id: "karura-route-policy-v1",
      },
      rules: [
        {
          id: "split-rule",
          selector: { way_ids: [1001], node_ids: [420, 421, 422] },
          policy: { routing_state: "exclude" },
        },
      ],
    },
    features,
  );

  const document = buildRoutePolicyDocument(editorState, features);
  assert.deepEqual(document.rules, [
    {
      id: "split-rule",
      selector: { way_ids: [1001], node_ids: [420, 421, 422] },
      policy: { routing_state: "exclude" },
    },
  ]);
  assert.equal(countRoutePolicyChanges(editorState, features), 0);
});

test("buildRoutePolicyDocument splits edited runs from an originally grouped rule", () => {
  const features = featureMap(
    feature(10, [1001], [420, 421]),
    feature(11, [1001], [421, 422]),
  );
  const editorState = normalizeRoutePolicyDocument(
    {
      meta: {
        asset_kind: "route_policy",
        asset_id: "karura-route-policy-v1",
      },
      rules: [
        {
          id: "split-rule",
          selector: { way_ids: [1001], node_ids: [420, 421, 422] },
          policy: { routing_state: "exclude" },
        },
      ],
    },
    features,
  );

  setContigPolicy(editorState, 11, {
    routingState: "include",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  });

  const document = buildRoutePolicyDocument(editorState, features);
  assert.equal(document.rules.length, 2);
  assert.match(document.rules[0].id, /^route-policy-path-[0-9a-f]{8}$/);
  assert.deepEqual(document.rules[0].selector, { way_ids: [1001], node_ids: [420, 421] });
  assert.deepEqual(document.rules[0].policy, { routing_state: "exclude" });
  assert.match(document.rules[1].id, /^route-policy-path-[0-9a-f]{8}$/);
  assert.deepEqual(document.rules[1].selector, { way_ids: [1001], node_ids: [421, 422] });
  assert.deepEqual(document.rules[1].policy, { routing_state: "include" });
  assert.equal(countRoutePolicyChanges(editorState, features), 3);
});

test("normalizeRoutePolicyDocument rejects malformed route policy documents", () => {
  assert.throws(
    () => normalizeRoutePolicyDocument({ meta: { asset_kind: "route_policy", asset_id: "x" } }),
    /Route policy must contain a rules array/,
  );
  assert.throws(
    () =>
      normalizeRoutePolicyDocument({
        meta: { asset_kind: "route_policy", asset_id: "x" },
        rules: [
          {
            id: "bad",
            selector: { way_ids: [1], node_ids: [10, 11] },
            policy: {},
          },
        ],
      }),
    /policy must contain at least one policy field/,
  );
  assert.throws(
    () => normalizeRoutePolicyDocument([]),
    /Route policy must be a JSON object/,
  );
});

test("normalizeRoutePolicyDocument rejects legacy patches with unsupported non-policy tags", () => {
  const features = featureMap(feature(55, [5501], [550, 551]));
  assert.throws(
    () =>
      normalizeRoutePolicyDocument(
        {
          meta: {
            asset_kind: "map_patchset",
            patchset_id: "legacy-policy",
          },
          patches: [
            {
              id: "editor-policy-contig-55",
              op: "update_contig_tags",
              contig_id: 55,
              node_ids: [550, 551],
              set: {
                [POLICY_TAGS.routingState]: "exclude",
                surface: "gravel",
              },
            },
          ],
        },
        features,
      ),
    /unsupported non-policy tags/,
  );
});

test("setContigPolicy removes default policy from managed state", () => {
  const editorState = normalizeRoutePolicyDocument(emptyRoutePolicyDocument());
  setContigPolicy(editorState, 11, {
    routingState: "include",
    bikeability: 4,
    bicycleDirection: "forward",
    unavailableUntil: "2026-05-10",
  });
  assert.notDeepEqual(policyForContig(editorState, 11), defaultWayPolicy());
  setContigPolicy(editorState, 11, defaultWayPolicy());
  assert.deepEqual(policyForContig(editorState, 11), defaultWayPolicy());
});

test("buffer-zone contigs are excluded by default without explicit route policy", () => {
  const features = featureMap(
    feature(90, [9001], [900, 901], { "local:boundary_zone": "buffer" }),
  );
  const editorState = normalizeRoutePolicyDocument(emptyRoutePolicyDocument(), features);

  assert.deepEqual(policyForContig(editorState, 90), {
    routingState: "exclude",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  });
  assert.equal(editorState.policyByContigId.size, 0);
});

test("setting buffer-zone contig back to exclude keeps it implicit on export", () => {
  const features = featureMap(
    feature(91, [9101], [910, 911], { "local:boundary_zone": "buffer" }),
  );
  const editorState = normalizeRoutePolicyDocument(emptyRoutePolicyDocument(), features);

  setContigPolicy(editorState, 91, {
    routingState: "exclude",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  });

  assert.equal(editorState.policyByContigId.size, 0);
  assert.equal(buildRoutePolicyDocument(editorState, features).rules.length, 0);
});

test("including a buffer-zone contig creates an explicit route policy rule", () => {
  const features = featureMap(
    feature(92, [9201], [920, 921], { "local:boundary_zone": "buffer" }),
  );
  const editorState = normalizeRoutePolicyDocument(emptyRoutePolicyDocument(), features);

  setContigPolicy(editorState, 92, {
    routingState: "include",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  });

  const document = buildRoutePolicyDocument(editorState, features);
  assert.equal(document.rules.length, 1);
  assert.deepEqual(document.rules[0].policy, {
    routing_state: "include",
  });
});

test("buildRoutePolicyDocument fails if a selected policy no longer matches the current graph", () => {
  const editorState = normalizeRoutePolicyDocument(emptyRoutePolicyDocument());
  setContigPolicy(editorState, 42, {
    routingState: "exclude",
    bikeability: null,
    bicycleDirection: "both",
    unavailableUntil: null,
  });
  assert.throws(
    () => buildRoutePolicyDocument(editorState, new Map()),
    /Current graph is missing contig 42/,
  );
});

test("normalizeRoutePolicyDocument rejects ambiguous selectors on the current graph", () => {
  const features = featureMap(
    feature(10, [1001], [420, 421, 422]),
    feature(11, [1001], [422, 421, 420]),
  );
  assert.throws(
    () =>
      normalizeRoutePolicyDocument(
        {
          meta: {
            asset_kind: "route_policy",
            asset_id: "karura-route-policy-v1",
          },
          rules: [
            {
              id: "ambiguous",
              selector: { way_ids: [1001], node_ids: [420, 421, 422] },
              policy: { routing_state: "exclude" },
            },
          ],
        },
        features,
      ),
    /selector matches multiple current contigs/,
  );
});
