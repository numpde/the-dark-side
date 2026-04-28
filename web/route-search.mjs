const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Route search module");
const { karuraTodayString, isBoundaryDefaultExcluded, isCurrentlyUnavailable } = await import(`./karura-policy.mjs${moduleSuffix}`);
const { sampleWeighted } = await import(`./route-selection.mjs${moduleSuffix}`);

function isShortConnector(contig, config) {
  return contig.lengthM <= config.short_connector_max_length_m;
}

function canTraverseContig(contig, visitCount, overlapLengthM, config, fromNodeId, toNodeId, todayString) {
  const routingState = contig.tags["local:routing_state"];
  if (routingState === "exclude") {
    return { allowed: false, reused: false };
  }
  if (isCurrentlyUnavailable(contig.tags, todayString)) {
    return { allowed: false, reused: false };
  }
  if (routingState !== "include" && isBoundaryDefaultExcluded(contig.tags)) {
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

export function createInitialState(startNodeId) {
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

export function rankCandidates(candidates) {
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

export function uniqueRankedCandidates(candidates) {
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

export function rolloutRoute(graph, {
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

export function routeReward(graph, candidate, endNodeId, config, loopMode, todayString) {
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

export function expandMctsNode(graph, { node, endNodeId, config, random, todayString }) {
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

export { karuraTodayString };
