function requireModuleVersion() {
  const version = new URL(import.meta.url).searchParams.get("v");
  if (!version) {
    throw new Error("Route selection module is missing required module version");
  }
  return version;
}

const MODULE_VERSION = requireModuleVersion();
const moduleSuffix = `?v=${encodeURIComponent(MODULE_VERSION)}`;
const { requireInteger } = await import(`./contract-primitives.mjs${moduleSuffix}`);

export function sampleWeighted(items, weights, random) {
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

export function normalizeRouteHistory(value) {
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
      requireInteger(contigId, `route history[${sequenceIndex}][${contigIndex}]`, { coerce: true }),
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
  const rankIndex = new Map(
    rankedCandidates.map((candidate, index) => [candidate.steps.map((step) => step.contigId).join(","), index]),
  );
  const weights = pool.map((candidate) =>
    Math.max(1, pool.length - rankIndex.get(candidate.steps.map((step) => step.contigId).join(","))),
  );
  return sampleWeighted(pool, weights, random);
}

export function pickHistoryAwarePrimaryCandidate(rankedCandidates, random, config, historySequences) {
  if (!historySequences.length) {
    return pickSeededPrimaryCandidate(rankedCandidates, random, config);
  }

  const windowSize = Math.max(
    config.selection_window * 3,
    config.selection_pool * 4,
    24,
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
    Math.max(1e-6, pool.length - index + Math.max(0, entry.novelty) * 5),
  );
  return sampleWeighted(pool, weights, random).candidate;
}
