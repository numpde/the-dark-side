import test from "node:test";
import assert from "node:assert/strict";
const { parsePlannerWorkerResponse } = await import("../web/planner-worker-contracts.mjs");

function routePayload(overrides = {}) {
  return {
    id: "route-1",
    algorithm: "browser-mcts",
    seed: 7,
    complete: true,
    score: 123.4,
    total_length_m: 1000,
    unique_length_m: 950,
    overlap_length_m: 50,
    step_count: 3,
    repeated_contig_ids: [],
    bounds: [36.81, -1.24, 36.82, -1.23],
    coordinates: [[36.81, -1.24], [36.82, -1.23]],
    route_node_ids: [1, 2],
    contig_id_sequence: [10],
    ...overrides,
  };
}

test("planner worker route payload requires repeated_contig_ids explicitly", () => {
  assert.throws(
    () => parsePlannerWorkerResponse({
      type: "planned",
      requestId: 1,
      payload: routePayload({ repeated_contig_ids: undefined }),
    }),
    /worker planned payload\.repeated_contig_ids/
  );
});

test("planner worker route payload accepts explicit repeated_contig_ids", () => {
  const message = parsePlannerWorkerResponse({
    type: "planned",
    requestId: 1,
    payload: routePayload({ repeated_contig_ids: [10] }),
  });
  assert.equal(message.type, "planned");
  assert.deepEqual(message.payload.repeated_contig_ids, [10]);
});
