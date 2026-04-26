import test from "node:test";
import assert from "node:assert/strict";

import { buildGraphFromGeoJson, planBrowserRoute } from "../web/route-planner.mjs";

const CONFIG = {
  short_connector_max_length_m: 35,
  max_overlap_m: 70,
  max_steps: 64,
  random_top_k: 3,
  end_stop_unused_slack_m: 400,
  end_finish_unused_slack_m: 250,
  future_length_weight: 0.08,
  connector_length_weight: 0.02,
  overlap_penalty_per_m: 12,
  articulation_penalty: 45,
  articulation_future_threshold_m: 400,
  dead_end_penalty: 180,
  early_finish_penalty: 320,
  beam_width: 12,
  beam_branch_factor: 2,
  beam_rounds: 24,
  beam_selection_pool: 3,
  beam_selection_window: 6,
  elevation_smoothing_window: 3,
  elevation_min_step_m: 0.5,
};

function feature(contigId, nodeIds, coordinates, extra = {}) {
  return {
    type: "Feature",
    properties: {
      contig_id: contigId,
      endpoint_node_ids: [nodeIds[0], nodeIds[nodeIds.length - 1]],
      node_ids: nodeIds,
      length_m: extra.length_m ?? 100,
      segment_count: nodeIds.length - 1,
      way_ids: extra.way_ids ?? [contigId],
      way_names: extra.way_names ?? [],
      tags: extra.tags ?? {},
      elevations_m: extra.elevations_m ?? nodeIds.map((_, index) => 1800 + index * 2),
    },
    geometry: {
      type: "LineString",
      coordinates,
    },
  };
}

test("browser planner avoids excluded contigs and returns a complete route", () => {
  const payload = {
    type: "FeatureCollection",
    features: [
      feature(1, [1, 2], [[36.81, -1.24], [36.811, -1.241]], { length_m: 120 }),
      feature(2, [2, 3], [[36.811, -1.241], [36.812, -1.242]], {
        length_m: 120,
        tags: { "local:routing_state": "exclude" },
      }),
      feature(3, [2, 4], [[36.811, -1.241], [36.8115, -1.2405]], { length_m: 90 }),
      feature(4, [4, 3], [[36.8115, -1.2405], [36.812, -1.242]], { length_m: 90 }),
    ],
  };

  const graph = buildGraphFromGeoJson(payload);
  const route = planBrowserRoute(graph, {
    startNodeId: 1,
    endNodeId: 3,
    seed: 7,
    config: CONFIG,
    routeId: "test-route",
  });

  assert.equal(route.complete, true);
  assert.deepEqual(route.contig_id_sequence, [1, 3, 4]);
  assert.ok(!route.contig_id_sequence.includes(2));
  assert.equal(route.id, "test-route");
  assert.equal(route.coordinates.length, 4);
  assert.equal(typeof route.elevation_gain_m, "number");
  assert.equal(typeof route.elevation_loss_m, "number");
});

test("browser planner respects unavailable_until tags", () => {
  const payload = {
    type: "FeatureCollection",
    features: [
      feature(10, [10, 11], [[36.82, -1.24], [36.821, -1.241]], { length_m: 100 }),
      feature(11, [11, 12], [[36.821, -1.241], [36.822, -1.242]], {
        length_m: 100,
        tags: { "local:unavailable_until": "2099-01-01" },
      }),
      feature(12, [11, 13], [[36.821, -1.241], [36.8212, -1.2402]], { length_m: 70 }),
      feature(13, [13, 12], [[36.8212, -1.2402], [36.822, -1.242]], { length_m: 70 }),
    ],
  };

  const graph = buildGraphFromGeoJson(payload);
  const route = planBrowserRoute(graph, {
    startNodeId: 10,
    endNodeId: 12,
    seed: 11,
    config: CONFIG,
  });

  assert.equal(route.complete, true);
  assert.deepEqual(route.contig_id_sequence, [10, 12, 13]);
  assert.ok(!route.contig_id_sequence.includes(11));
});

test("browser planner returns a non-empty loop for start=end scenarios", () => {
  const payload = {
    type: "FeatureCollection",
    features: [
      feature(20, [20, 21], [[36.83, -1.24], [36.831, -1.241]], { length_m: 110 }),
      feature(21, [21, 22], [[36.831, -1.241], [36.832, -1.2404]], { length_m: 95 }),
      feature(22, [22, 20], [[36.832, -1.2404], [36.83, -1.24]], { length_m: 105 }),
    ],
  };

  const graph = buildGraphFromGeoJson(payload);
  const route = planBrowserRoute(graph, {
    startNodeId: 20,
    endNodeId: 20,
    seed: 19,
    config: CONFIG,
  });

  assert.equal(route.complete, true);
  assert.ok(route.contig_id_sequence.length > 0);
  assert.ok(route.unique_length_m > 0);
  assert.equal(route.route_node_ids[0], 20);
  assert.equal(route.route_node_ids.at(-1), 20);
});

test("browser planner rejects malformed network payloads instead of falling back to an empty graph", () => {
  assert.throws(
    () => buildGraphFromGeoJson({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            contig_id: 1,
            endpoint_node_ids: [1, 2],
            node_ids: [1, 2],
            length_m: 100,
            segment_count: 1,
            way_ids: [1],
            way_names: [],
            tags: {},
          },
          geometry: {
            type: "LineString",
            coordinates: [[36.81, -1.24]],
          },
        },
      ],
    }),
    /Invalid route network: features\[0\]\.geometry\.coordinates must contain at least two points/
  );
});

test("browser planner rejects endpoint mismatches instead of silently inferring them", () => {
  assert.throws(
    () => buildGraphFromGeoJson({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            contig_id: 2,
            endpoint_node_ids: [1, 99],
            node_ids: [1, 2],
            length_m: 100,
            segment_count: 1,
            way_ids: [2],
            way_names: [],
            tags: {},
          },
          geometry: {
            type: "LineString",
            coordinates: [[36.81, -1.24], [36.811, -1.241]],
          },
        },
      ],
    }),
    /Invalid route network: features\[0\] endpoint_node_ids must match the first and last node_ids/
  );
});
