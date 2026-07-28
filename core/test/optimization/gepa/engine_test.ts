/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvaluationBatch, GepaAdapter} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {
  defaultProposer,
  GepaResult,
  optimize,
} from '../../../src/optimization/gepa/engine.js';

type EvalData = Record<string, unknown>;

/** Returns the prompt of the candidate that achieved `bestScore`. */
function bestPromptOf(result: GepaResult): string {
  return result.candidates[result.valAggregateScores.indexOf(result.bestScore)]
    .agent_prompt;
}

/** In-memory adapter whose scores depend only on the candidate prompt. */
class FakeAdapter implements GepaAdapter<string, EvalData, EvalData> {
  proposeNewTexts?: (
    candidate: Record<string, string>,
    reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
    componentsToUpdate: string[],
  ) => Promise<Record<string, string>>;

  constructor(
    private readonly scoreFn: (prompt: string, id: string) => number,
  ) {}

  async evaluate(
    batch: string[],
    candidate: Record<string, string>,
    _captureTraces = false,
  ): Promise<EvaluationBatch<EvalData, EvalData>> {
    const scores = batch.map((id) => this.scoreFn(candidate.agent_prompt, id));
    const data = batch.map((id) => ({id}));
    return {outputs: data, scores, trajectories: data};
  }

  makeReflectiveDataset(
    candidate: Record<string, string>,
    evalBatch: EvaluationBatch<EvalData, EvalData>,
    componentsToUpdate: string[],
  ): Record<string, Array<Record<string, unknown>>> {
    const rows = evalBatch.scores.map((score, i) => ({
      agent_prompt: candidate.agent_prompt,
      score,
      eval_data: evalBatch.trajectories?.[i] ?? {},
    }));
    const result: Record<string, Array<Record<string, unknown>>> = {};
    for (const component of componentsToUpdate) {
      result[component] = rows;
    }
    return result;
  }
}

describe('gepa engine optimize', () => {
  it('returns only the seed when the budget is spent on the baseline', async () => {
    const adapter = new FakeAdapter((prompt) => (prompt === 'seed' ? 0.4 : 1));
    const reflectionLm = vi.fn(async () => 'improved');

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2'],
      valset: ['v1', 'v2'],
      adapter,
      reflectionLm,
      maxMetricCalls: 2,
      reflectionMinibatchSize: 2,
      seed: 1,
    });

    expect(result.candidates).toEqual([{agent_prompt: 'seed'}]);
    expect(result.valAggregateScores).toEqual([0.4]);
    expect(result.totalMetricCalls).toBe(2);
    expect(result.bestScore).toBe(0.4);
    expect(reflectionLm).not.toHaveBeenCalled();
    expect(result.toJSON()).toEqual({
      candidates: [{agent_prompt: 'seed'}],
      valAggregateScores: [0.4],
      bestScore: 0.4,
      totalMetricCalls: 2,
    });
  });

  it('adds an improving child to the pool and reports the best', async () => {
    const adapter = new FakeAdapter((prompt) =>
      prompt === 'improved' ? 1 : 0,
    );
    const reflectionLm = vi.fn(async () => 'improved');

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2', 't3', 't4'],
      valset: ['v1', 'v2'],
      adapter,
      reflectionLm,
      maxMetricCalls: 100,
      reflectionMinibatchSize: 2,
      seed: 42,
    });

    const prompts = result.candidates.map((c) => c.agent_prompt);
    expect(prompts).toContain('improved');
    expect(bestPromptOf(result)).toBe('improved');
    expect(result.bestScore).toBe(1);
    expect(result.totalMetricCalls).toBeLessThanOrEqual(100);
    expect(reflectionLm).toHaveBeenCalled();
  });

  it('does not add a child that fails to improve the minibatch mean', async () => {
    const adapter = new FakeAdapter(() => 0.5);
    const reflectionLm = vi.fn(async () => 'other');

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2'],
      valset: ['v1', 'v2'],
      adapter,
      reflectionLm,
      maxMetricCalls: 20,
      reflectionMinibatchSize: 2,
      seed: 7,
    });

    expect(result.candidates).toEqual([{agent_prompt: 'seed'}]);
  });

  it('breaks before evaluating a parent minibatch when the budget is tight', async () => {
    const adapter = new FakeAdapter((prompt) =>
      prompt === 'improved' ? 1 : 0,
    );
    const reflectionLm = vi.fn(async () => 'improved');

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2'],
      valset: ['v1', 'v2'],
      adapter,
      reflectionLm,
      maxMetricCalls: 3,
      reflectionMinibatchSize: 2,
      seed: 1,
    });

    expect(result.totalMetricCalls).toBe(2);
    expect(result.candidates).toEqual([{agent_prompt: 'seed'}]);
    expect(reflectionLm).not.toHaveBeenCalled();
  });

  it('breaks before evaluating a child minibatch when the budget is tight', async () => {
    const adapter = new FakeAdapter((prompt) =>
      prompt === 'improved' ? 1 : 0,
    );
    const reflectionLm = vi.fn(async () => 'improved');

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2'],
      valset: ['v1', 'v2'],
      adapter,
      reflectionLm,
      maxMetricCalls: 5,
      reflectionMinibatchSize: 2,
      seed: 1,
    });

    expect(result.totalMetricCalls).toBe(4);
    expect(result.candidates).toEqual([{agent_prompt: 'seed'}]);
    expect(reflectionLm).toHaveBeenCalledTimes(1);
  });

  it('breaks before the child validation eval when the budget is tight', async () => {
    const adapter = new FakeAdapter((prompt) =>
      prompt === 'improved' ? 1 : 0,
    );
    const reflectionLm = vi.fn(async () => 'improved');

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2'],
      valset: ['v1', 'v2'],
      adapter,
      reflectionLm,
      maxMetricCalls: 5,
      reflectionMinibatchSize: 1,
      seed: 1,
    });

    expect(result.totalMetricCalls).toBe(4);
    expect(result.candidates).toEqual([{agent_prompt: 'seed'}]);
  });

  it('selects the highest-mean parent with the current-best strategy', async () => {
    const trainIds = new Set(['t1', 't2', 't3', 't4']);
    const scoreFn = (prompt: string, id: string): number => {
      if (trainIds.has(id)) {
        return prompt === 'A' ? 1 : prompt === 'B' ? 2 : 0;
      }
      if (prompt === 'A') {
        return 1;
      }
      if (prompt === 'B') {
        return id === 'v1' ? 1 : 0;
      }
      return 0;
    };
    const adapter = new FakeAdapter(scoreFn);
    const proposals = ['A', 'B', 'C', 'C', 'C', 'C'];
    let call = 0;
    const reflectionLm = vi.fn(
      async () => proposals[Math.min(call++, proposals.length - 1)],
    );

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2', 't3', 't4'],
      valset: ['v1', 'v2'],
      adapter,
      reflectionLm,
      maxMetricCalls: 20,
      reflectionMinibatchSize: 2,
      candidateSelectionStrategy: 'current-best',
      seed: 3,
    });

    const prompts = result.candidates.map((c) => c.agent_prompt);
    expect(prompts).toContain('A');
    expect(prompts).toContain('B');
    expect(bestPromptOf(result)).toBe('A');
    expect(result.bestScore).toBe(1);
  });

  it('selects from the non-dominated set with the pareto strategy', async () => {
    const trainIds = new Set(['t1', 't2', 't3', 't4']);
    const scoreFn = (prompt: string, id: string): number => {
      if (trainIds.has(id)) {
        return prompt === 'A' ? 1 : prompt === 'B' ? 2 : 0;
      }
      // A and B share a validation vector (v1:1, v2:0) so neither dominates.
      return prompt === 'A' || prompt === 'B' ? (id === 'v1' ? 1 : 0) : 0;
    };
    const adapter = new FakeAdapter(scoreFn);
    const proposals = ['A', 'B', 'C', 'C', 'C', 'C'];
    let call = 0;
    const reflectionLm = vi.fn(
      async () => proposals[Math.min(call++, proposals.length - 1)],
    );

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2', 't3', 't4'],
      valset: ['v1', 'v2'],
      adapter,
      reflectionLm,
      maxMetricCalls: 20,
      reflectionMinibatchSize: 2,
      candidateSelectionStrategy: 'pareto',
      seed: 11,
    });

    const prompts = result.candidates.map((c) => c.agent_prompt);
    expect(prompts).toContain('A');
    expect(prompts).toContain('B');
    expect(result.bestScore).toBeCloseTo(0.5);
  });

  it('uses the adapter proposeNewTexts hook and Math.random when unseeded', async () => {
    const adapter = new FakeAdapter((prompt) => (prompt === 'custom' ? 1 : 0));
    const proposeNewTexts = vi.fn(async () => ({agent_prompt: 'custom'}));
    adapter.proposeNewTexts = proposeNewTexts;
    const reflectionLm = vi.fn(async () => 'unused');

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1', 't2', 't3'],
      valset: ['v1'],
      adapter,
      reflectionLm,
      maxMetricCalls: 20,
      reflectionMinibatchSize: 2,
    });

    expect(proposeNewTexts).toHaveBeenCalled();
    expect(reflectionLm).not.toHaveBeenCalled();
    expect(result.candidates.map((c) => c.agent_prompt)).toContain('custom');
  });

  it('uses all training examples when the minibatch size is not smaller', async () => {
    const adapter = new FakeAdapter((prompt) =>
      prompt === 'improved' ? 1 : 0,
    );
    const reflectionLm = vi.fn(async () => 'improved');

    const result = await optimize({
      seedCandidate: {agent_prompt: 'seed'},
      trainset: ['t1'],
      valset: ['v1'],
      adapter,
      reflectionLm,
      maxMetricCalls: 20,
      reflectionMinibatchSize: 3,
      seed: 5,
    });

    expect(result.candidates.map((c) => c.agent_prompt)).toContain('improved');
  });
});

describe('gepa engine defaultProposer', () => {
  it('renders one prompt per component and applies the trimmed response', async () => {
    const reflectionLm = vi.fn(async () => '  new text  ');

    const result = await defaultProposer(
      {agent_prompt: 'old', extra: 'x'},
      {agent_prompt: [{score: 1, eval_data: {}}]},
      ['agent_prompt', 'extra'],
      reflectionLm,
    );

    expect(reflectionLm).toHaveBeenCalledTimes(2);
    expect(result).toEqual({agent_prompt: 'new text', extra: 'new text'});
  });
});
