import test from "node:test";
import assert from "node:assert/strict";

import { resolveCanonicalSelection, resolveScenarioSelection } from "../web/route-scenarios.mjs";

const area = {
  id: "karura",
  scenarios: [
    { id: "a", start_junction_id: "s1", end_junction_id: "e1", is_loop: false },
    { id: "b", start_junction_id: "s2", end_junction_id: "e1", is_loop: false },
    { id: "c", start_junction_id: "s2", end_junction_id: "e2", is_loop: false },
  ],
};

test("resolveScenarioSelection preserves exact matches", () => {
  const resolved = resolveScenarioSelection(area, {
    startJunctionId: "s2",
    endJunctionId: "e1",
    preferredAnchor: "start",
  });
  assert.equal(resolved.canonicalized, false);
  assert.equal(resolved.scenario.id, "b");
});

test("resolveScenarioSelection canonicalizes invalid pairs by preferred start", () => {
  const resolved = resolveScenarioSelection(area, {
    startJunctionId: "s2",
    endJunctionId: "missing-end",
    preferredAnchor: "start",
  });
  assert.equal(resolved.canonicalized, true);
  assert.equal(resolved.scenario.id, "b");
});

test("resolveScenarioSelection canonicalizes invalid pairs by preferred end", () => {
  const resolved = resolveScenarioSelection(area, {
    startJunctionId: "missing-start",
    endJunctionId: "e2",
    preferredAnchor: "end",
  });
  assert.equal(resolved.canonicalized, true);
  assert.equal(resolved.scenario.id, "c");
});

test("resolveCanonicalSelection canonicalizes invalid query params", () => {
  const manifest = {
    areas: [area],
  };
  const resolved = resolveCanonicalSelection(manifest, "?area=karura&start=s2&end=missing-end");
  assert.equal(resolved.canonicalized, true);
  assert.equal(resolved.area.id, "karura");
  assert.deepEqual(resolved.canonical, {
    areaId: "karura",
    startJunctionId: "s2",
    endJunctionId: "e1",
  });
});
