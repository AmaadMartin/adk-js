/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {
  GepaEngine,
  GepaOptimizeParams,
  GepaRunResult,
  ReflectionLm,
} from './gepa_engine.js';

/** The file {@link DefaultGepaEngine} writes into `runDir`. */
const RESULT_FILE_NAME = 'gepa_result.json';

/** Options for {@link DefaultGepaEngine}. */
export interface DefaultGepaEngineOptions {
  /**
   * Seeds the random number generator, which makes a run reproducible.
   * Defaults to `Math.random`.
   */
  seed?: number;
}

/** A candidate with its per-validation-example scores and their mean. */
interface PoolEntry {
  /** The component texts the candidate holds. */
  candidate: Record<string, string>;

  /** One validation score per example, in `valset` order. */
  scores: number[];

  /** The mean of {@link PoolEntry.scores}. */
  mean: number;
}

/** Returns the arithmetic mean of a non-empty list of numbers. */
function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Builds a random number generator.
 *
 * @param seed Makes the sequence deterministic (mulberry32). Without it the
 *     generator is `Math.random`.
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
 * Samples up to `size` distinct examples from `trainset`.
 *
 * @returns All of `trainset`, in order, when it is not larger than `size`.
 */
function sampleMinibatch(
  trainset: string[],
  size: number,
  rng: () => number,
): string[] {
  if (trainset.length <= size) {
    return [...trainset];
  }
  const remaining = [...trainset];
  const minibatch: string[] = [];
  for (let picked = 0; picked < size; picked++) {
    minibatch.push(
      remaining.splice(Math.floor(rng() * remaining.length), 1)[0],
    );
  }
  return minibatch;
}

/** Reports whether `a` Pareto-dominates `b` over their aligned scores. */
function dominates(a: number[], b: number[]): boolean {
  let betterSomewhere = false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] < b[index]) {
      return false;
    }
    if (a[index] > b[index]) {
      betterSomewhere = true;
    }
  }
  return betterSomewhere;
}

/** Returns the pool entries no other entry dominates. */
function paretoFront(pool: PoolEntry[]): PoolEntry[] {
  return pool.filter(
    (entry, index) =>
      !pool.some(
        (other, otherIndex) =>
          otherIndex !== index && dominates(other.scores, entry.scores),
      ),
  );
}

/** Picks the candidate the next round reflects on. */
function selectParent(pool: PoolEntry[], rng: () => number): PoolEntry {
  const front = paretoFront(pool);
  return front[Math.floor(rng() * front.length)];
}

/**
 * Renders the prompt the reflection model answers for one component.
 *
 * @param component The component name being rewritten.
 * @param currentText The text the component holds now.
 * @param rows The reflective-dataset records for that component.
 */
export function renderReflectionPrompt(
  component: string,
  currentText: string,
  rows: Array<Record<string, unknown>>,
): string {
  const feedback = rows
    .map((row, index) => `Example ${index + 1}: ${JSON.stringify(row)}`)
    .join('\n');
  return `You are optimizing the text of a component named "${component}".

Current text:
"""
${currentText}
"""

The current text was evaluated on the following examples. Each row carries the score (higher is better) and the evaluation data:
${feedback}

Write an improved version of the component text that scores higher on these and similar examples. Answer with ONLY the new component text, without commentary or quotes.`;
}

/**
 * Proposes new component text by asking the reflection model.
 *
 * An engine uses this when the adapter supplies no `proposeNewTexts`.
 *
 * @param candidate The component texts the parent holds.
 * @param reflectiveDataset The records `makeReflectiveDataset` produced.
 * @param componentsToUpdate The component names to rewrite.
 * @param reflectionLm The model call that answers each reflection prompt.
 * @returns The new text of each requested component.
 */
export async function proposeWithReflection(
  candidate: Record<string, string>,
  reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
  componentsToUpdate: string[],
  reflectionLm: ReflectionLm,
): Promise<Record<string, string>> {
  const proposals: Record<string, string> = {};
  for (const component of componentsToUpdate) {
    const answer = await reflectionLm(
      renderReflectionPrompt(
        component,
        candidate[component],
        reflectiveDataset[component] ?? [],
      ),
    );
    proposals[component] = answer.trim();
  }
  return proposals;
}

/** Rejects the inputs no search can make progress on. */
function validateSearchInputs({
  trainset,
  valset,
  maxMetricCalls,
}: GepaOptimizeParams): void {
  if (valset.length === 0) {
    throw new Error('A GEPA run needs at least one validation example.');
  }
  if (trainset.length === 0) {
    throw new Error('A GEPA run needs at least one training example.');
  }
  if (maxMetricCalls < valset.length) {
    throw new Error(
      `A GEPA run needs a budget of at least ${valset.length} metric calls ` +
        `to score the seed candidate on the validation set, but ` +
        `maxMetricCalls is ${maxMetricCalls}.`,
    );
  }
}

/** Builds the result the engine reports. */
function buildRunResult(
  pool: PoolEntry[],
  totalMetricCalls: number,
): GepaRunResult {
  const candidates = pool.map((entry) => entry.candidate);
  const valAggregateScores = pool.map((entry) => entry.mean);
  return {
    candidates,
    valAggregateScores,
    details: {
      candidates,
      valAggregateScores,
      bestScore: Math.max(...valAggregateScores),
      totalMetricCalls,
    },
  };
}

/**
 * The GEPA search engine ADK bundles.
 *
 * It scores the seed candidate on the validation set, then repeatedly picks a
 * parent, reflects over a training minibatch to propose a rewrite, and keeps a
 * child that beats its parent on that minibatch. Every evaluated example
 * counts as one metric call, and the search stops before it spends more than
 * `maxMetricCalls` of them.
 *
 * adk-python delegates this to the PyPI package `gepa`, which npm has no
 * equivalent of, so the search here is an independent implementation of the
 * same loop rather than a port of that package.
 */
export class DefaultGepaEngine implements GepaEngine {
  private readonly seed?: number;

  constructor(options: DefaultGepaEngineOptions = {}) {
    this.seed = options.seed;
  }

  /**
   * Runs the search.
   *
   * @param params The seed candidate, the two example sets, the adapter, the
   *     metric-call budget, and the reflection model call.
   * @returns Every candidate the search kept, with its mean validation score.
   * @throws If either example set is empty, or if the budget cannot even score
   *     the seed candidate on the validation set.
   */
  async optimize(params: GepaOptimizeParams): Promise<GepaRunResult> {
    validateSearchInputs(params);
    const {
      seedCandidate,
      trainset,
      valset,
      adapter,
      maxMetricCalls,
      reflectionLm,
      reflectionMinibatchSize,
      runDir,
    } = params;
    const componentKeys = Object.keys(seedCandidate);
    const rng = makeRng(this.seed);

    const seedEval = await adapter.evaluate(valset, seedCandidate, false);
    let totalMetricCalls = valset.length;
    const pool: PoolEntry[] = [
      {
        candidate: seedCandidate,
        scores: seedEval.scores,
        mean: mean(seedEval.scores),
      },
    ];

    while (totalMetricCalls < maxMetricCalls) {
      const parent = selectParent(pool, rng);
      const minibatch = sampleMinibatch(trainset, reflectionMinibatchSize, rng);

      // A round scores the parent and the child on the same minibatch, so it
      // is only worth starting when the budget covers both.
      if (totalMetricCalls + 2 * minibatch.length > maxMetricCalls) {
        break;
      }

      const parentEval = await adapter.evaluate(
        minibatch,
        parent.candidate,
        true,
      );
      totalMetricCalls += minibatch.length;
      const reflectiveDataset = adapter.makeReflectiveDataset(
        parent.candidate,
        parentEval,
        componentKeys,
      );
      const proposals = adapter.proposeNewTexts
        ? await adapter.proposeNewTexts(
            parent.candidate,
            reflectiveDataset,
            componentKeys,
          )
        : await proposeWithReflection(
            parent.candidate,
            reflectiveDataset,
            componentKeys,
            reflectionLm,
          );
      const child = {...parent.candidate, ...proposals};

      const childEval = await adapter.evaluate(minibatch, child, true);
      totalMetricCalls += minibatch.length;
      if (mean(childEval.scores) <= mean(parentEval.scores)) {
        continue;
      }

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

    const result = buildRunResult(pool, totalMetricCalls);
    if (runDir !== undefined) {
      await mkdir(runDir, {recursive: true});
      await writeFile(
        join(runDir, RESULT_FILE_NAME),
        JSON.stringify(result.details, null, 2),
      );
    }
    return result;
  }
}
