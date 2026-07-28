/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GepaAdapter} from './adapter.js';

/**
 * A reflection language model: given a prompt, returns generated text.
 */
export type ReflectionLm = (prompt: string) => Promise<string>;

/**
 * The strategy used to pick the parent candidate to reflect on each iteration.
 *
 * - `'pareto'`: sample uniformly from the non-dominated set over per-validation
 *   example scores.
 * - `'current-best'`: pick the candidate with the highest mean validation score.
 */
export type CandidateSelectionStrategy = 'pareto' | 'current-best';

/**
 * Configuration for a single GEPA optimization run.
 *
 * @typeParam D The type of a single example identifier.
 */
export interface GepaOptimizeConfig<D = string> {
  /** The initial candidate component texts to seed the search. */
  seedCandidate: Record<string, string>;

  /** The example identifiers used for reflection minibatches. */
  trainset: D[];

  /** The example identifiers used to score candidates. */
  valset: D[];

  /** The adapter used to evaluate candidates and build reflective datasets. */
  adapter: GepaAdapter<D>;

  /** The reflection LM used by the default proposer. */
  reflectionLm: ReflectionLm;

  /** The maximum number of example evaluations (metric calls) to make. */
  maxMetricCalls: number;

  /** The number of training examples to use per reflection minibatch. */
  reflectionMinibatchSize: number;

  /** How to select the parent candidate each iteration. Defaults to `'pareto'`. */
  candidateSelectionStrategy?: CandidateSelectionStrategy;

  /** Optional seed for deterministic minibatch sampling and parent selection. */
  seed?: number;
}

/**
 * The result of a GEPA optimization run.
 */
export interface GepaResult {
  /** Every candidate retained in the pool (index-aligned with scores). */
  candidates: Array<Record<string, string>>;

  /** The mean validation score of each candidate (index-aligned). */
  valAggregateScores: number[];

  /** The highest mean validation score. */
  bestScore: number;

  /** The total number of example evaluations performed. */
  totalMetricCalls: number;

  /** Returns a plain, JSON-serializable view of the result. */
  toJSON(): Record<string, unknown>;
}

/** A candidate together with its per-validation-example scores and their mean. */
interface PoolEntry {
  candidate: Record<string, string>;
  scores: number[];
  mean: number;
}

/** Returns the arithmetic mean of a non-empty array of numbers. */
function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Builds a pseudo-random number generator. When `seed` is provided the sequence
 * is deterministic (mulberry32); otherwise `Math.random` is used.
 */
function makeRng(seed?: number): () => number {
  if (seed === undefined) {
    return Math.random;
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Samples up to `size` distinct examples from `trainset`. Returns all examples
 * (in order) when the set is not larger than `size`.
 */
function sampleMinibatch<D>(
  trainset: D[],
  size: number,
  rng: () => number,
): D[] {
  if (trainset.length <= size) {
    return [...trainset];
  }
  const remaining = [...trainset];
  const minibatch: D[] = [];
  for (let i = 0; i < size; i++) {
    const index = Math.floor(rng() * remaining.length);
    minibatch.push(remaining.splice(index, 1)[0]);
  }
  return minibatch;
}

/** Returns true if `a` Pareto-dominates `b` over their aligned score vectors. */
function dominates(a: number[], b: number[]): boolean {
  let strictlyBetterSomewhere = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) {
      return false;
    }
    if (a[i] > b[i]) {
      strictlyBetterSomewhere = true;
    }
  }
  return strictlyBetterSomewhere;
}

/** Returns the non-dominated entries of the pool. */
function paretoFront(pool: PoolEntry[]): PoolEntry[] {
  return pool.filter(
    (entry, i) =>
      !pool.some(
        (other, j) => j !== i && dominates(other.scores, entry.scores),
      ),
  );
}

/** Selects the parent candidate to reflect on according to the strategy. */
function selectParent(
  pool: PoolEntry[],
  strategy: CandidateSelectionStrategy,
  rng: () => number,
): PoolEntry {
  if (strategy === 'current-best') {
    return pool.reduce((best, entry) =>
      entry.mean > best.mean ? entry : best,
    );
  }
  const front = paretoFront(pool);
  return front[Math.floor(rng() * front.length)];
}

/** Renders the default reflection prompt for a single component. */
function renderReflectionPrompt(
  component: string,
  currentText: string,
  rows: Array<Record<string, unknown>>,
): string {
  const feedback = rows
    .map((row, i) => `Example ${i + 1}: ${JSON.stringify(row)}`)
    .join('\n');
  return `You are optimizing the text of a component named "${component}".

Current text:
"""
${currentText}
"""

The current text was evaluated on the following examples. Each row shows the score (higher is better) and the evaluation data:
${feedback}

Write an improved version of the component text that will score higher on these and similar examples. Respond with ONLY the new component text, without commentary or quotes.`;
}

/**
 * The default reflective proposer: for each component, renders a reflection
 * prompt embedding the current text and feedback, calls the reflection LM, and
 * uses the trimmed response as the proposed new text.
 *
 * @param candidate The current candidate component texts.
 * @param reflectiveDataset The reflective dataset for the components.
 * @param componentsToUpdate The component names to propose new texts for.
 * @param reflectionLm The reflection LM to call.
 * @returns A map from component name to the proposed new text.
 */
export async function defaultProposer(
  candidate: Record<string, string>,
  reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
  componentsToUpdate: string[],
  reflectionLm: ReflectionLm,
): Promise<Record<string, string>> {
  const newTexts: Record<string, string> = {};
  for (const component of componentsToUpdate) {
    const prompt = renderReflectionPrompt(
      component,
      candidate[component],
      reflectiveDataset[component] ?? [],
    );
    const response = await reflectionLm(prompt);
    newTexts[component] = response.trim();
  }
  return newTexts;
}

/**
 * A native, minimal GEPA (reflective prompt evolution) optimizer.
 *
 * It evaluates a seed candidate, then repeatedly selects a parent, reflects on
 * a training minibatch to propose an improved candidate, and keeps children
 * that improve the minibatch mean — scoring them on the validation set. The
 * loop is bounded by `maxMetricCalls` (each evaluated example counts as one
 * metric call).
 *
 * @typeParam D The type of a single example identifier.
 * @param config The optimization configuration.
 * @returns The optimization result, including the retained candidate pool.
 */
export async function optimize<D = string>(
  config: GepaOptimizeConfig<D>,
): Promise<GepaResult> {
  const {
    seedCandidate,
    trainset,
    valset,
    adapter,
    reflectionLm,
    maxMetricCalls,
    reflectionMinibatchSize,
  } = config;
  const strategy = config.candidateSelectionStrategy ?? 'pareto';
  const componentKeys = Object.keys(seedCandidate);
  const rng = makeRng(config.seed);

  let totalMetricCalls = 0;

  // Baseline: evaluate the seed candidate on the validation set. This is
  // mandatory so the result always has at least one scored candidate.
  const seedEval = await adapter.evaluate(valset, seedCandidate, false);
  totalMetricCalls += valset.length;
  const pool: PoolEntry[] = [
    {
      candidate: seedCandidate,
      scores: seedEval.scores,
      mean: mean(seedEval.scores),
    },
  ];

  while (totalMetricCalls < maxMetricCalls) {
    const parent = selectParent(pool, strategy, rng);
    const minibatch = sampleMinibatch(trainset, reflectionMinibatchSize, rng);

    if (totalMetricCalls + minibatch.length > maxMetricCalls) {
      break;
    }
    const parentEval = await adapter.evaluate(
      minibatch,
      parent.candidate,
      true,
    );
    totalMetricCalls += minibatch.length;
    const parentMean = mean(parentEval.scores);

    const reflectiveDataset = adapter.makeReflectiveDataset(
      parent.candidate,
      parentEval,
      componentKeys,
    );
    const newTexts = adapter.proposeNewTexts
      ? await adapter.proposeNewTexts(
          parent.candidate,
          reflectiveDataset,
          componentKeys,
        )
      : await defaultProposer(
          parent.candidate,
          reflectiveDataset,
          componentKeys,
          reflectionLm,
        );
    const child = {...parent.candidate, ...newTexts};

    if (totalMetricCalls + minibatch.length > maxMetricCalls) {
      break;
    }
    const childEval = await adapter.evaluate(minibatch, child, true);
    totalMetricCalls += minibatch.length;

    if (mean(childEval.scores) > parentMean) {
      if (totalMetricCalls + valset.length > maxMetricCalls) {
        break;
      }
      const childValEval = await adapter.evaluate(valset, child, false);
      totalMetricCalls += valset.length;
      pool.push({
        candidate: child,
        scores: childValEval.scores,
        mean: mean(childValEval.scores),
      });
    }
  }

  const candidates = pool.map((entry) => entry.candidate);
  const valAggregateScores = pool.map((entry) => entry.mean);
  const bestScore = Math.max(...valAggregateScores);

  return {
    candidates,
    valAggregateScores,
    bestScore,
    totalMetricCalls,
    toJSON: () => ({
      candidates,
      valAggregateScores,
      bestScore,
      totalMetricCalls,
    }),
  };
}
