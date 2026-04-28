import { requireFiniteNumber, requireInteger } from "./contract-primitives.mjs";
import { buildGraphFromGeoJson, buildRoutePayload } from "./route-graph.mjs";
import {
  normalizeRouteHistory,
  pickHistoryAwarePrimaryCandidate,
} from "./route-selection.mjs";
import {
  createInitialState,
  expandMctsNode,
  rankCandidates,
  rolloutRoute,
  routeReward,
  uniqueRankedCandidates,
  karuraTodayString,
} from "./route-search.mjs";

export { buildGraphFromGeoJson };

function makeRng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function monotonicNowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
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
    elevation_smoothing_window: requireInteger(
      config.elevation_smoothing_window,
      "planner config.elevation_smoothing_window",
    ),
    elevation_min_step_m: requireFiniteNumber(
      config.elevation_min_step_m,
      "planner config.elevation_min_step_m",
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
      const expandedNode = expandMctsNode(graph, {
        node,
        endNodeId,
        config: plannerConfig,
        random,
        todayString,
      });
      if (expandedNode !== node) {
        node = expandedNode;
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
