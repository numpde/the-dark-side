import { requireFiniteNumber, requireInteger } from "./contract-primitives.mjs";
import { karuraTodayString, isCurrentlyUnavailable } from "./karura-policy.mjs";
import { normalizeRouteNetworkFeatureCollection } from "./route-network-contracts.mjs";

function makeRng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWeighted(items, weights, random) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!total) {
    return items[0];
  }
  let threshold = random() * total;
  for (let index = 0; index < items.length; index += 1) {
    threshold -= weights[index];
    if (threshold <= 0) {
      return items[index];
    }
  }
  return items[items.length - 1];
}

function haversineMeters(lonA, latA, lonB, latB) {
  const toRad = Math.PI / 180;
  const dLat = (latB - latA) * toRad;
  const dLon = (lonB - lonA) * toRad;
  const aLat = latA * toRad;
  const bLat = latB * toRad;
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000.0 * Math.asin(Math.sqrt(value));
}

function cumulativeDistances(coordinates) {
  if (!coordinates.length) {
    return [];
  }
  const distances = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const first = coordinates[index - 1];
    const second = coordinates[index];
    distances.push(
      distances[distances.length - 1]
      + haversineMeters(first[0], first[1], second[0], second[1])
    );
  }
  return distances;
}

function movingAverage(values, window) {
  if (window <= 1 || values.length <= 2) {
    return [...values];
  }
  const radius = Math.max(0, Math.floor(window / 2));
  return values.map((_, index) => {
    const left = Math.max(0, index - radius);
    const right = Math.min(values.length, index + radius + 1);
    const sample = values.slice(left, right);
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  });
}

function computeGainLoss(values, minStepM) {
  let gain = 0;
  let loss = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (Math.abs(delta) < minStepM) {
      continue;
    }
    if (delta > 0) {
      gain += delta;
    } else {
      loss += -delta;
    }
  }
  return { gain, loss };
}

function roundCoordinate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundMeters(value) {
  return Math.round(value * 1000) / 1000;
}

function buildBounds(coordinates) {
  const lons = coordinates.map((coordinate) => coordinate[0]);
  const lats = coordinates.map((coordinate) => coordinate[1]);
  return [
    roundCoordinate(Math.min(...lons)),
    roundCoordinate(Math.min(...lats)),
    roundCoordinate(Math.max(...lons)),
    roundCoordinate(Math.max(...lats)),
  ];
}

function nodeCoordinate(coordinate) {
  return [roundCoordinate(coordinate[0]), roundCoordinate(coordinate[1])];
}

export function buildGraphFromGeoJson(payload) {
  const features = normalizeRouteNetworkFeatureCollection(payload);
  const nodes = new Map();
  const contigs = new Map();
  const adjacency = new Map();

  for (const feature of features) {
    const properties = feature.properties;
    const coordinates = feature.geometry.coordinates;
    const nodeIds = properties.node_ids;
    const endpointNodeIds = properties.endpoint_node_ids;
    const elevations = Array.isArray(properties.elevations_m) ? properties.elevations_m : null;

    const contig = {
      id: properties.contig_id,
      endpointNodeIds,
      nodeIds,
      coordinates: coordinates.map(nodeCoordinate),
      elevations: elevations && elevations.length === nodeIds.length
        ? elevations.map((value) => Number(value))
        : null,
      lengthM: properties.length_m,
      segmentCount: properties.segment_count,
      wayIds: properties.way_ids,
      wayNames: [...properties.way_names],
      tags: { ...properties.tags },
      isCycle: endpointNodeIds[0] === endpointNodeIds[1],
    };
    if (contigs.has(contig.id)) {
      throw new Error(`Invalid route network: duplicate contig_id ${contig.id}`);
    }
    contigs.set(contig.id, contig);

    nodeIds.forEach((nodeId, index) => {
      if (!nodes.has(nodeId)) {
        nodes.set(nodeId, {
          id: nodeId,
          lon: contig.coordinates[index][0],
          lat: contig.coordinates[index][1],
          elevationM: contig.elevations ? contig.elevations[index] : null,
        });
        return;
      }
      const existing = nodes.get(nodeId);
      if (existing.elevationM == null && contig.elevations) {
        existing.elevationM = contig.elevations[index];
      }
    });

    const [firstNodeId, secondNodeId] = endpointNodeIds;
    if (!adjacency.has(firstNodeId)) {
      adjacency.set(firstNodeId, []);
    }
    adjacency.get(firstNodeId).push([contig.id, secondNodeId]);
    if (firstNodeId !== secondNodeId) {
      if (!adjacency.has(secondNodeId)) {
        adjacency.set(secondNodeId, []);
      }
      adjacency.get(secondNodeId).push([contig.id, firstNodeId]);
    }
  }

  for (const [nodeId, node] of nodes.entries()) {
    node.degree = (adjacency.get(nodeId) || []).length;
  }

  return {
    nodes,
    contigs,
    adjacency,
    articulationPoints: findArticulationPoints(adjacency),
  };
}

function findArticulationPoints(adjacency) {
  const graph = new Map();
  for (const [nodeId, edges] of adjacency.entries()) {
    graph.set(nodeId, new Set(edges.map(([, neighbor]) => neighbor).filter((neighbor) => neighbor !== nodeId)));
  }

  const discovery = new Map();
  const low = new Map();
  const parent = new Map();
  const articulation = new Set();
  let time = 0;

  function visit(nodeId) {
    time += 1;
    discovery.set(nodeId, time);
    low.set(nodeId, time);
    let childCount = 0;

    const neighbors = [...(graph.get(nodeId) || [])].sort((a, b) => a - b);
    for (const neighbor of neighbors) {
      if (!discovery.has(neighbor)) {
        parent.set(neighbor, nodeId);
        childCount += 1;
        visit(neighbor);
        low.set(nodeId, Math.min(low.get(nodeId), low.get(neighbor)));
        if (!parent.has(nodeId) && childCount > 1) {
          articulation.add(nodeId);
        }
        if (parent.has(nodeId) && low.get(neighbor) >= discovery.get(nodeId)) {
          articulation.add(nodeId);
        }
      } else if (neighbor !== parent.get(nodeId)) {
        low.set(nodeId, Math.min(low.get(nodeId), discovery.get(neighbor)));
      }
    }
  }

  for (const nodeId of [...graph.keys()].sort((a, b) => a - b)) {
    if (discovery.has(nodeId)) {
      continue;
    }
    parent.delete(nodeId);
    visit(nodeId);
  }

  return articulation;
}

function isShortConnector(contig, config) {
  return contig.lengthM <= config.short_connector_max_length_m;
}

function canTraverseContig(contig, visitCount, overlapLengthM, config, fromNodeId, toNodeId, todayString) {
  if (contig.tags["local:routing_state"] === "exclude") {
    return { allowed: false, reused: false };
  }
  if (isCurrentlyUnavailable(contig.tags, todayString)) {
    return { allowed: false, reused: false };
  }
  const direction = contig.tags["local:bicycle_direction"] || "both";
  if (!contig.isCycle) {
    const [firstNodeId, secondNodeId] = contig.endpointNodeIds;
    if (direction === "forward" && (fromNodeId !== firstNodeId || toNodeId !== secondNodeId)) {
      return { allowed: false, reused: false };
    }
    if (direction === "backward" && (fromNodeId !== secondNodeId || toNodeId !== firstNodeId)) {
      return { allowed: false, reused: false };
    }
  }
  if (visitCount === 0) {
    return { allowed: true, reused: false };
  }
  if (
    visitCount === 1
    && isShortConnector(contig, config)
    && overlapLengthM + contig.lengthM <= config.max_overlap_m
  ) {
    return { allowed: true, reused: true };
  }
  return { allowed: false, reused: false };
}

function cloneVisitCounts(visitCounts) {
  return new Map(visitCounts);
}

function extendState(state, step) {
  const nextVisitCounts = cloneVisitCounts(state.visitCounts);
  nextVisitCounts.set(step.contigId, (nextVisitCounts.get(step.contigId) || 0) + 1);
  const overlapDelta = step.reused ? step.lengthM : 0;
  const uniqueDelta = step.reused ? 0 : step.lengthM;
  return {
    currentNodeId: step.toNodeId,
    steps: [...state.steps, step],
    visitCounts: nextVisitCounts,
    totalLengthM: state.totalLengthM + step.lengthM,
    uniqueLengthM: state.uniqueLengthM + uniqueDelta,
    overlapLengthM: state.overlapLengthM + overlapDelta,
  };
}

function priorityQueuePop(queue) {
  queue.sort((a, b) => {
    if (a.overlap !== b.overlap) {
      return a.overlap - b.overlap;
    }
    return a.total - b.total;
  });
  return queue.shift();
}

function bestConnectorPlan(graph, visitCounts, startNodeId, endNodeId, overlapLengthM, config, todayString) {
  if (startNodeId === endNodeId) {
    return { reachable: true, overlapLengthM: 0, totalLengthM: 0, steps: [] };
  }

  const overlapRemaining = config.max_overlap_m - overlapLengthM;
  const queue = [{ overlap: 0, total: 0, nodeId: startNodeId }];
  const bestCost = new Map([[startNodeId, [0, 0]]]);
  const parents = new Map();

  while (queue.length) {
    const current = priorityQueuePop(queue);
    const currentBest = bestCost.get(current.nodeId);
    if (!currentBest || currentBest[0] !== current.overlap || currentBest[1] !== current.total) {
      continue;
    }
    if (current.nodeId === endNodeId) {
      break;
    }

    for (const [contigId, nextNodeId] of graph.adjacency.get(current.nodeId) || []) {
      const contig = graph.contigs.get(contigId);
      const visitCount = visitCounts.get(contigId) || 0;
      const { allowed, reused } = canTraverseContig(
        contig,
        visitCount,
        overlapLengthM + current.overlap,
        config,
        current.nodeId,
        nextNodeId,
        todayString,
      );
      if (!allowed) {
        continue;
      }

      const stepOverlap = reused ? contig.lengthM : 0;
      const nextOverlap = current.overlap + stepOverlap;
      if (nextOverlap > overlapRemaining) {
        continue;
      }

      const nextTotal = current.total + contig.lengthM;
      const candidateCost = [nextOverlap, nextTotal];
      const previousCost = bestCost.get(nextNodeId);
      if (
        previousCost
        && (
          previousCost[0] < candidateCost[0]
          || (previousCost[0] === candidateCost[0] && previousCost[1] <= candidateCost[1])
        )
      ) {
        continue;
      }

      bestCost.set(nextNodeId, candidateCost);
      parents.set(nextNodeId, {
        previousNodeId: current.nodeId,
        contigId,
        reused,
      });
      queue.push({ overlap: nextOverlap, total: nextTotal, nodeId: nextNodeId });
    }
  }

  if (!bestCost.has(endNodeId)) {
    return { reachable: false, overlapLengthM: Infinity, totalLengthM: Infinity, steps: [] };
  }

  const steps = [];
  let cursor = endNodeId;
  while (cursor !== startNodeId) {
    const parent = parents.get(cursor);
    const contig = graph.contigs.get(parent.contigId);
    steps.push({
      contigId: parent.contigId,
      fromNodeId: parent.previousNodeId,
      toNodeId: cursor,
      reused: parent.reused,
      lengthM: contig.lengthM,
    });
    cursor = parent.previousNodeId;
  }
  steps.reverse();

  const [connectorOverlap, connectorTotal] = bestCost.get(endNodeId);
  return {
    reachable: true,
    overlapLengthM: connectorOverlap,
    totalLengthM: connectorTotal,
    steps,
  };
}

function estimateReachableUnusedLength(graph, visitCounts, startNodeId, overlapLengthM, config, todayString) {
  const queue = [{ nodeId: startNodeId, overlap: 0 }];
  const bestOverlap = new Map([[startNodeId, 0]]);
  const seenContigs = new Set();
  let unusedLengthM = 0;

  while (queue.length) {
    const { nodeId, overlap } = queue.shift();
    for (const [contigId, nextNodeId] of graph.adjacency.get(nodeId) || []) {
      const contig = graph.contigs.get(contigId);
      const visitCount = visitCounts.get(contigId) || 0;
      const { allowed, reused } = canTraverseContig(
        contig,
        visitCount,
        overlapLengthM + overlap,
        config,
        nodeId,
        nextNodeId,
        todayString,
      );
      if (!allowed) {
        continue;
      }

      const nextOverlap = overlap + (reused ? contig.lengthM : 0);
      if (visitCount === 0 && !seenContigs.has(contigId)) {
        unusedLengthM += contig.lengthM;
        seenContigs.add(contigId);
      }
      const previousOverlap = bestOverlap.get(nextNodeId);
      if (previousOverlap != null && nextOverlap >= previousOverlap) {
        continue;
      }
      bestOverlap.set(nextNodeId, nextOverlap);
      queue.push({ nodeId: nextNodeId, overlap: nextOverlap });
    }
  }

  return unusedLengthM;
}

function scoreMove(graph, step, endNodeId, futureUnusedLengthM, connectorPlan, config) {
  let score = step.lengthM;
  score += config.future_length_weight * futureUnusedLengthM;
  score -= config.connector_length_weight * connectorPlan.totalLengthM;
  if (step.reused) {
    score -= config.overlap_penalty_per_m * step.lengthM;
  }
  if (step.toNodeId === endNodeId && futureUnusedLengthM > config.end_finish_unused_slack_m) {
    score -= config.early_finish_penalty;
  }
  if (graph.articulationPoints.has(step.toNodeId) && futureUnusedLengthM > config.articulation_future_threshold_m) {
    score -= config.articulation_penalty;
  }
  if ((graph.nodes.get(step.toNodeId)?.degree || 0) <= 1 && step.toNodeId !== endNodeId) {
    score -= config.dead_end_penalty;
  }
  return score;
}

function moveCandidates(graph, state, endNodeId, config, todayString) {
  const candidates = [];
  for (const [contigId, nextNodeId] of graph.adjacency.get(state.currentNodeId) || []) {
    const contig = graph.contigs.get(contigId);
    const lastStep = state.steps[state.steps.length - 1];
    if (lastStep && lastStep.contigId === contigId && !contig.isCycle) {
      continue;
    }
    const { allowed, reused } = canTraverseContig(
      contig,
      state.visitCounts.get(contigId) || 0,
      state.overlapLengthM,
      config,
      state.currentNodeId,
      nextNodeId,
      todayString,
    );
    if (!allowed) {
      continue;
    }

    const step = {
      contigId,
      fromNodeId: state.currentNodeId,
      toNodeId: nextNodeId,
      reused,
      lengthM: contig.lengthM,
    };
    const nextState = extendState(state, step);
    const connectorPlan = bestConnectorPlan(
      graph,
      nextState.visitCounts,
      nextState.currentNodeId,
      endNodeId,
      nextState.overlapLengthM,
      config,
      todayString,
    );
    if (!connectorPlan.reachable) {
      continue;
    }
    const futureUnusedLengthM = estimateReachableUnusedLength(
      graph,
      nextState.visitCounts,
      nextState.currentNodeId,
      nextState.overlapLengthM,
      config,
      todayString,
    );
    candidates.push({
      step,
      score: scoreMove(graph, step, endNodeId, futureUnusedLengthM, connectorPlan, config),
      futureUnusedLengthM,
      connectorPlan,
    });
  }

  const nonTerminal = candidates.filter((candidate) => candidate.step.toNodeId !== endNodeId);
  return nonTerminal.length ? nonTerminal : candidates;
}

function chooseWeightedCandidates(candidates, random, topK, count) {
  const ranked = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK));
  const selected = [];
  const pool = [...ranked];
  while (pool.length && selected.length < count) {
    const weights = pool.map((_, index) => Math.max(1, pool.length - index));
    const choice = sampleWeighted(pool, weights, random);
    selected.push(choice);
    pool.splice(pool.indexOf(choice), 1);
  }
  return selected;
}

function createInitialState(startNodeId) {
  return {
    currentNodeId: startNodeId,
    steps: [],
    visitCounts: new Map(),
    totalLengthM: 0,
    uniqueLengthM: 0,
    overlapLengthM: 0,
  };
}

function connectToEndIfPossible(graph, state, endNodeId, config, todayString) {
  const connector = bestConnectorPlan(
    graph,
    state.visitCounts,
    state.currentNodeId,
    endNodeId,
    state.overlapLengthM,
    config,
    todayString,
  );
  if (!connector.reachable) {
    return state;
  }
  let currentState = state;
  for (const step of connector.steps) {
    currentState = extendState(currentState, step);
  }
  return currentState;
}

function finalizeCandidate(graph, state, endNodeId, config, todayString) {
  const connector = bestConnectorPlan(
    graph,
    state.visitCounts,
    state.currentNodeId,
    endNodeId,
    state.overlapLengthM,
    config,
    todayString,
  );
  const futureUnusedLengthM = estimateReachableUnusedLength(
    graph,
    state.visitCounts,
    state.currentNodeId,
    state.overlapLengthM,
    config,
    todayString,
  );
  let score = state.uniqueLengthM - 10 * state.overlapLengthM + 0.01 * futureUnusedLengthM;
  if (state.currentNodeId === endNodeId) {
    score += 250;
  } else if (connector.reachable) {
    score -= 0.05 * connector.totalLengthM;
  } else {
    score -= 500;
  }
  return {
    complete: state.currentNodeId === endNodeId,
    score,
    totalLengthM: state.totalLengthM,
    uniqueLengthM: state.uniqueLengthM,
    overlapLengthM: state.overlapLengthM,
    terminalNodeId: state.currentNodeId,
    steps: state.steps,
  };
}

function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const keyA = [
      a.complete ? 1 : 0,
      a.uniqueLengthM,
      -a.overlapLengthM,
      a.score,
      -a.steps.length,
    ];
    const keyB = [
      b.complete ? 1 : 0,
      b.uniqueLengthM,
      -b.overlapLengthM,
      b.score,
      -b.steps.length,
    ];
    for (let index = 0; index < keyA.length; index += 1) {
      if (keyA[index] !== keyB[index]) {
        return keyB[index] - keyA[index];
      }
    }
    return 0;
  });
}

function uniqueRankedCandidates(candidates) {
  const unique = new Map();
  for (const candidate of rankCandidates(candidates)) {
    const signature = candidate.steps.map((step) => step.contigId).join(",");
    if (!unique.has(signature)) {
      unique.set(signature, candidate);
    }
  }
  return [...unique.values()];
}

function shouldStopAtEnd(graph, state, endNodeId, choices, config, random, todayString) {
  if (state.currentNodeId !== endNodeId || !state.steps.length) {
    return false;
  }
  if (!choices.length) {
    return true;
  }

  const futureUnusedLengthM = estimateReachableUnusedLength(
    graph,
    state.visitCounts,
    state.currentNodeId,
    state.overlapLengthM,
    config,
    todayString,
  );
  if (futureUnusedLengthM > config.end_stop_unused_slack_m) {
    return false;
  }
  return random() < config.end_stop_probability;
}

function rolloutRoute(graph, {
  initialState,
  endNodeId,
  config,
  random,
  todayString,
  topK,
}) {
  let state = initialState;
  for (let index = 0; index < Math.max(0, config.max_steps - state.steps.length); index += 1) {
    const choices = moveCandidates(graph, state, endNodeId, config, todayString);
    if (shouldStopAtEnd(graph, state, endNodeId, choices, config, random, todayString)) {
      break;
    }
    if (!choices.length) {
      break;
    }
    const chosen = chooseWeightedCandidates(choices, random, topK, 1)[0];
    state = extendState(state, chosen.step);
  }

  state = connectToEndIfPossible(graph, state, endNodeId, config, todayString);
  return finalizeCandidate(graph, state, endNodeId, config, todayString);
}

function candidateVisitCounts(candidate) {
  const visitCounts = new Map();
  for (const step of candidate.steps) {
    visitCounts.set(step.contigId, (visitCounts.get(step.contigId) || 0) + 1);
  }
  return visitCounts;
}

function candidateFutureUnusedLength(graph, candidate, config, todayString) {
  return estimateReachableUnusedLength(
    graph,
    candidateVisitCounts(candidate),
    candidate.terminalNodeId,
    candidate.overlapLengthM,
    config,
    todayString,
  );
}

function routeReward(graph, candidate, endNodeId, config, loopMode, todayString) {
  let reward = candidate.score;
  const futureUnusedLengthM = candidateFutureUnusedLength(graph, candidate, config, todayString);
  if (candidate.complete && loopMode && candidate.terminalNodeId === endNodeId) {
    const coverageRatio = candidate.uniqueLengthM / Math.max(
      1,
      candidate.uniqueLengthM + futureUnusedLengthM,
    );
    reward += config.mcts_loop_completion_bonus;
    reward += config.mcts_loop_late_return_bonus * coverageRatio;
    reward -= config.mcts_loop_unused_penalty_per_m * futureUnusedLengthM;
    reward -= config.mcts_loop_overlap_penalty_per_m * candidate.overlapLengthM;
  }
  return reward / 1000;
}

function mctsNodeValue(node, config) {
  if (node.visits === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const exploit = node.rewardSum / node.visits;
  const explore = config.mcts_exploration_weight
    * Math.sqrt(Math.log(Math.max(1, node.parent.visits)) / node.visits);
  const prior = node.move ? config.mcts_prior_weight * (node.move.score / 1000) : 0;
  return exploit + explore + prior;
}

function selectMctsChild(node, random, config) {
  const scored = node.children.map((child) => ({ value: mctsNodeValue(child, config), child }));
  const bestValue = Math.max(...scored.map((item) => item.value));
  const tied = scored
    .filter((item) => Math.abs(item.value - bestValue) < 1e-12)
    .map((item) => item.child);
  return tied[Math.floor(random() * tied.length)];
}

function expandMctsNode(graph, { node, endNodeId, config, random, todayString }) {
  if (node.unexpandedMoves === null) {
    node.unexpandedMoves = moveCandidates(graph, node.state, endNodeId, config, todayString);
  }
  if (!node.unexpandedMoves.length) {
    return node;
  }

  const chosen = chooseWeightedCandidates(
    node.unexpandedMoves,
    random,
    config.mcts_rollout_top_k,
    1,
  )[0];
  node.unexpandedMoves = node.unexpandedMoves.filter((candidate) => candidate !== chosen);
  const child = {
    state: extendState(node.state, chosen.step),
    parent: node,
    move: chosen,
    visits: 0,
    rewardSum: 0,
    children: [],
    unexpandedMoves: null,
  };
  node.children.push(child);
  return child;
}

function contigJaccardSimilarity(candidateA, candidateB) {
  const a = new Set(candidateA.steps.map((step) => step.contigId));
  const b = new Set(candidateB.steps.map((step) => step.contigId));
  return contigSetJaccardSimilarity(a, b);
}

function contigSetJaccardSimilarity(a, b) {
  const union = new Set([...a, ...b]);
  if (!union.size) {
    return 1;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }
  return intersection / union.size;
}

function normalizeRouteHistory(value) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Route history must be an array of contig-id arrays");
  }
  return value.map((sequence, sequenceIndex) => {
    if (!Array.isArray(sequence)) {
      throw new Error(`Route history entry ${sequenceIndex} must be an array`);
    }
    return sequence.map((contigId, contigIndex) =>
      requireInteger(contigId, `route history[${sequenceIndex}][${contigIndex}]`)
    );
  });
}

function buildDiverseCandidatePool(rankedCandidates, poolSize, selectionWindow) {
  if (!rankedCandidates.length) {
    return [];
  }
  const window = rankedCandidates.slice(0, Math.max(poolSize, selectionWindow));
  const pool = [window[0]];
  const remaining = window.slice(1);
  while (remaining.length && pool.length < poolSize) {
    let bestIndex = 0;
    let bestScore = [-1, Number.NEGATIVE_INFINITY];
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const diversity = Math.min(...pool.map((selected) => 1 - contigJaccardSimilarity(candidate, selected)));
      const score = [diversity, candidate.score];
      if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
        bestScore = score;
        bestIndex = index;
      }
    }
    pool.push(remaining.splice(bestIndex, 1)[0]);
  }
  return pool;
}

function pickSeededPrimaryCandidate(rankedCandidates, random, config) {
  const pool = buildDiverseCandidatePool(
    rankedCandidates,
    Math.min(config.selection_pool, rankedCandidates.length),
    Math.min(config.selection_window, rankedCandidates.length),
  );
  if (!pool.length) {
    return null;
  }
  const rankIndex = new Map(rankedCandidates.map((candidate, index) => [candidate.steps.map((step) => step.contigId).join(","), index]));
  const weights = pool.map((candidate) => Math.max(1, pool.length - rankIndex.get(candidate.steps.map((step) => step.contigId).join(","))));
  return sampleWeighted(pool, weights, random);
}

function pickHistoryAwarePrimaryCandidate(rankedCandidates, random, config, historySequences) {
  if (!historySequences.length) {
    return pickSeededPrimaryCandidate(rankedCandidates, random, config);
  }

  const windowSize = Math.max(
    config.selection_window * 3,
    config.selection_pool * 4,
    24
  );
  const window = rankedCandidates.slice(0, Math.min(windowSize, rankedCandidates.length));
  if (!window.length) {
    return null;
  }

  const historySignatureSet = new Set(historySequences.map((sequence) => sequence.join(",")));
  const historySets = historySequences.map((sequence) => new Set(sequence));
  const bestScore = Math.max(...window.map((candidate) => candidate.score), 1);
  const bestUniqueLength = Math.max(...window.map((candidate) => candidate.uniqueLengthM), 1);

  const rankedByNovelty = window
    .map((candidate, index) => {
      const signature = candidate.steps.map((step) => step.contigId).join(",");
      const candidateSet = new Set(candidate.steps.map((step) => step.contigId));
      const maxSimilarity = historySets.length
        ? Math.max(...historySets.map((historySet) => contigSetJaccardSimilarity(candidateSet, historySet)))
        : 0;
      const novelty = 1 - maxSimilarity;
      const qualityRatio = candidate.score / bestScore;
      const lengthRatio = candidate.uniqueLengthM / bestUniqueLength;
      const overlapRatio = candidate.overlapLengthM / Math.max(1, candidate.totalLengthM);
      const duplicatePenalty = historySignatureSet.has(signature) ? 10 : 0;
      return {
        candidate,
        signature,
        novelty,
        maxSimilarity,
        combinedScore:
          5.0 * novelty
          + 1.0 * qualityRatio
          + 0.35 * lengthRatio
          - 0.8 * overlapRatio
          - duplicatePenalty
          - 0.03 * index,
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);

  const nonDuplicate = rankedByNovelty.filter((entry) => !historySignatureSet.has(entry.signature));
  const noveltyPreferred = nonDuplicate.filter((entry) => entry.maxSimilarity < 0.94);
  const source = noveltyPreferred.length ? noveltyPreferred : (nonDuplicate.length ? nonDuplicate : rankedByNovelty);
  const poolSize = Math.min(Math.max(config.selection_pool, 3), source.length);
  const pool = source.slice(0, Math.max(1, poolSize));
  const weights = pool.map((entry, index) =>
    Math.max(1e-6, pool.length - index + Math.max(0, entry.novelty) * 5)
  );
  return sampleWeighted(pool, weights, random).candidate;
}

function orientContigNodeIds(contig, fromNodeId, toNodeId) {
  if (contig.isCycle) {
    return [...contig.nodeIds];
  }
  if (contig.nodeIds[0] === fromNodeId && contig.nodeIds[contig.nodeIds.length - 1] === toNodeId) {
    return [...contig.nodeIds];
  }
  if (contig.nodeIds[0] === toNodeId && contig.nodeIds[contig.nodeIds.length - 1] === fromNodeId) {
    return [...contig.nodeIds].reverse();
  }
  throw new Error(`Contig ${contig.id} cannot be oriented for ${fromNodeId}->${toNodeId}`);
}

function buildRouteNodeIds(graph, steps) {
  const routeNodeIds = [];
  for (const step of steps) {
    const contig = graph.contigs.get(step.contigId);
    const oriented = orientContigNodeIds(contig, step.fromNodeId, step.toNodeId);
    if (!routeNodeIds.length) {
      routeNodeIds.push(...oriented);
      continue;
    }
    routeNodeIds.push(...oriented.slice(1));
  }
  return routeNodeIds;
}

function summarizeRouteElevations(coordinates, elevations, config) {
  const smoothed = movingAverage(elevations, config.elevation_smoothing_window || 3);
  const { gain, loss } = computeGainLoss(smoothed, config.elevation_min_step_m || 0.5);
  return {
    elevationsM: smoothed.map((value) => Math.round(value * 10) / 10),
    elevationGainM: Math.round(gain * 10) / 10,
    elevationLossM: Math.round(loss * 10) / 10,
    elevationMinM: Math.round(Math.min(...smoothed) * 10) / 10,
    elevationMaxM: Math.round(Math.max(...smoothed) * 10) / 10,
    totalDistanceM: cumulativeDistances(coordinates).at(-1) || 0,
  };
}

function repeatedContigIds(steps) {
  const visits = new Set();
  const repeated = [];
  for (const step of steps) {
    if (visits.has(step.contigId) && !repeated.includes(step.contigId)) {
      repeated.push(step.contigId);
    }
    visits.add(step.contigId);
  }
  return repeated;
}

function monotonicNowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function buildRoutePayload(graph, primary, { routeId, seed, algorithm, config }) {
  const routeNodeIds = buildRouteNodeIds(graph, primary.steps);
  const coordinates = routeNodeIds.map((nodeId) => {
    const node = graph.nodes.get(nodeId);
    return [roundCoordinate(node.lon), roundCoordinate(node.lat)];
  });
  const elevations = routeNodeIds.map((nodeId) => graph.nodes.get(nodeId)?.elevationM);
  const hasCompleteElevation = elevations.every((value) => typeof value === "number");
  const elevationSummary = hasCompleteElevation
    ? summarizeRouteElevations(coordinates, elevations, config)
    : null;

  return {
    id: routeId,
    algorithm,
    seed,
    complete: primary.complete,
    score: roundMeters(primary.score),
    total_length_m: roundMeters(primary.totalLengthM),
    unique_length_m: roundMeters(primary.uniqueLengthM),
    overlap_length_m: roundMeters(primary.overlapLengthM),
    step_count: primary.steps.length,
    repeated_contig_ids: repeatedContigIds(primary.steps),
    bounds: buildBounds(coordinates),
    coordinates,
    route_node_ids: routeNodeIds,
    contig_id_sequence: primary.steps.map((step) => step.contigId),
    ...(elevationSummary
      ? {
          elevations_m: elevationSummary.elevationsM,
          elevation_gain_m: elevationSummary.elevationGainM,
          elevation_loss_m: elevationSummary.elevationLossM,
          elevation_min_m: elevationSummary.elevationMinM,
          elevation_max_m: elevationSummary.elevationMaxM,
        }
      : {}),
  };
}

export function planBrowserRoute(graph, options) {
  const {
    startNodeId,
    endNodeId,
    seed = Date.now(),
    config,
    routeId = `browser-route-${seed}`,
    recentRouteContigSequences = [],
    onProgress = null,
  } = options;

  const random = makeRng(seed);
  const todayString = karuraTodayString();
  const routeHistory = normalizeRouteHistory(recentRouteContigSequences);
  const plannerConfig = {
    ...config,
    max_steps: requireInteger(config.max_steps, "planner config.max_steps"),
    random_top_k: requireInteger(config.random_top_k, "planner config.random_top_k"),
    end_stop_probability: requireFiniteNumber(
      config.end_stop_probability,
      "planner config.end_stop_probability",
    ),
    selection_pool: requireInteger(
      config.selection_pool,
      "planner config.selection_pool",
    ),
    selection_window: requireInteger(
      config.selection_window,
      "planner config.selection_window",
    ),
    mcts_iterations: requireInteger(config.mcts_iterations, "planner config.mcts_iterations"),
    mcts_exploration_weight: requireFiniteNumber(
      config.mcts_exploration_weight,
      "planner config.mcts_exploration_weight",
    ),
    mcts_rollout_top_k: requireInteger(
      config.mcts_rollout_top_k,
      "planner config.mcts_rollout_top_k",
    ),
    mcts_rollout_samples: requireInteger(
      config.mcts_rollout_samples,
      "planner config.mcts_rollout_samples",
    ),
    mcts_prior_weight: requireFiniteNumber(
      config.mcts_prior_weight,
      "planner config.mcts_prior_weight",
    ),
    mcts_loop_completion_bonus: requireFiniteNumber(
      config.mcts_loop_completion_bonus,
      "planner config.mcts_loop_completion_bonus",
    ),
    mcts_loop_unused_penalty_per_m: requireFiniteNumber(
      config.mcts_loop_unused_penalty_per_m,
      "planner config.mcts_loop_unused_penalty_per_m",
    ),
    mcts_loop_late_return_bonus: requireFiniteNumber(
      config.mcts_loop_late_return_bonus,
      "planner config.mcts_loop_late_return_bonus",
    ),
    mcts_loop_overlap_penalty_per_m: requireFiniteNumber(
      config.mcts_loop_overlap_penalty_per_m,
      "planner config.mcts_loop_overlap_penalty_per_m",
    ),
    mcts_time_budget_ms: requireFiniteNumber(
      config.mcts_time_budget_ms,
      "planner config.mcts_time_budget_ms",
    ),
    mcts_progress_interval_iterations: requireInteger(
      config.mcts_progress_interval_iterations,
      "planner config.mcts_progress_interval_iterations",
    ),
  };
  const loopMode = startNodeId === endNodeId;
  const root = {
    state: createInitialState(startNodeId),
    parent: null,
    move: null,
    visits: 0,
    rewardSum: 0,
    children: [],
    unexpandedMoves: null,
  };
  const candidates = [];
  const maxIterations = plannerConfig.mcts_iterations;
  const maxPlanningMs = plannerConfig.mcts_time_budget_ms;
  const progressIntervalIterations = Math.max(1, plannerConfig.mcts_progress_interval_iterations);
  const deadline = monotonicNowMs() + maxPlanningMs;
  let lastProgressSignature = null;

  function maybeEmitProgress(force = false) {
    if (typeof onProgress !== "function" || !candidates.length) {
      return;
    }
    const ranked = uniqueRankedCandidates(candidates.filter((candidate) => candidate.complete && candidate.steps.length));
    const primary = pickHistoryAwarePrimaryCandidate(ranked, random, plannerConfig, routeHistory) || ranked[0];
    if (!primary) {
      return;
    }
    const signature = primary.steps.map((step) => step.contigId).join(",");
    if (!force && signature === lastProgressSignature) {
      return;
    }
    lastProgressSignature = signature;
    onProgress(buildRoutePayload(graph, primary, {
      routeId,
      seed,
      algorithm: "browser-mcts-progress",
      config: plannerConfig,
    }));
  }

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (monotonicNowMs() >= deadline) {
      break;
    }
    let node = root;
    const path = [node];

    while (true) {
      if (node.state.steps.length >= plannerConfig.max_steps) {
        break;
      }
      if (node.unexpandedMoves === null) {
        node.unexpandedMoves = moveCandidates(graph, node.state, endNodeId, plannerConfig, todayString);
      }
      if (node.unexpandedMoves.length) {
        node = expandMctsNode(graph, {
          node,
          endNodeId,
          config: plannerConfig,
          random,
          todayString,
        });
        path.push(node);
        break;
      }
      if (!node.children.length) {
        break;
      }
      node = selectMctsChild(node, random, plannerConfig);
      path.push(node);
    }

    const rolloutCandidates = [];
    const rolloutSamples = Math.max(1, plannerConfig.mcts_rollout_samples);
    for (let sampleIndex = 0; sampleIndex < rolloutSamples; sampleIndex += 1) {
      rolloutCandidates.push(rolloutRoute(graph, {
        initialState: node.state,
        endNodeId,
        config: plannerConfig,
        random,
        todayString,
        topK: plannerConfig.mcts_rollout_top_k,
      }));
    }
    candidates.push(...rolloutCandidates);
    const candidate = rankCandidates(rolloutCandidates)[0];
    const reward = routeReward(graph, candidate, endNodeId, plannerConfig, loopMode, todayString);
    for (const visited of path) {
      visited.visits += 1;
      visited.rewardSum += reward;
    }

    if (progressIntervalIterations && ((iteration + 1) % progressIntervalIterations === 0)) {
      maybeEmitProgress(false);
    }
  }

  maybeEmitProgress(true);

  const ranked = uniqueRankedCandidates(candidates.filter((candidate) => candidate.complete && candidate.steps.length));
  const primary = pickHistoryAwarePrimaryCandidate(ranked, random, plannerConfig, routeHistory) || ranked[0];
  if (!primary) {
    throw new Error("No route candidate produced");
  }
  return buildRoutePayload(graph, primary, {
    routeId,
    seed,
    algorithm: "browser-mcts",
    config: plannerConfig,
  });
}
