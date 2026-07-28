/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Agent,
  AgentOptimizer,
  AgentWithScores,
  LlmAgent,
  OptimizerResult,
  Sampler,
  UnstructuredSamplingResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class FakeSampler extends Sampler<UnstructuredSamplingResult> {
  getTrainExampleIds(): string[] {
    return ['train1', 'train2'];
  }

  getValidationExampleIds(): string[] {
    return ['val1'];
  }

  async sampleAndScore(
    candidate: Agent,
    exampleSet: 'train' | 'validation' = 'validation',
    batch: string[] = [],
    captureFullEvalData = false,
  ): Promise<UnstructuredSamplingResult> {
    const scores: Record<string, number> = {};
    for (const id of batch) {
      scores[id] = 1;
    }
    return {
      scores,
      data: captureFullEvalData
        ? {[exampleSet]: {candidate: candidate.name}}
        : undefined,
    };
  }
}

class FakeOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  async optimize(
    initialAgent: Agent,
    sampler: Sampler<UnstructuredSamplingResult>,
  ): Promise<OptimizerResult<AgentWithScores>> {
    const batch = sampler.getValidationExampleIds();
    const result = await sampler.sampleAndScore(
      initialAgent,
      'validation',
      batch,
    );
    return {
      optimizedAgents: [
        {optimizedAgent: initialAgent, overallScore: result.scores[batch[0]]},
      ],
    };
  }
}

describe('optimization base module', () => {
  it('lets a concrete Sampler return train/validation ids and scores', async () => {
    const sampler = new FakeSampler();
    const agent = new LlmAgent({name: 'agent', instruction: 'i'});

    expect(sampler.getTrainExampleIds()).toEqual(['train1', 'train2']);
    expect(sampler.getValidationExampleIds()).toEqual(['val1']);

    const withData = await sampler.sampleAndScore(
      agent,
      'train',
      ['train1'],
      true,
    );
    expect(withData.scores).toEqual({train1: 1});
    expect(withData.data).toEqual({train: {candidate: 'agent'}});

    const withoutData = await sampler.sampleAndScore(agent, 'validation', [
      'val1',
    ]);
    expect(withoutData.data).toBeUndefined();
  });

  it('lets a concrete AgentOptimizer run against a Sampler', async () => {
    const optimizer = new FakeOptimizer();
    const sampler = new FakeSampler();
    const agent = new LlmAgent({name: 'agent', instruction: 'i'});

    const result = await optimizer.optimize(agent, sampler);

    expect(result.optimizedAgents).toHaveLength(1);
    expect(result.optimizedAgents[0].optimizedAgent).toBe(agent);
    expect(result.optimizedAgents[0].overallScore).toBe(1);
  });
});
