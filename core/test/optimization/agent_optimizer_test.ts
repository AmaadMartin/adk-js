/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LlmAgent,
  isLlmAgent,
  type AgentOptimizer,
  type AgentWithScores,
  type ExampleSet,
  type OptimizerResult,
  type SampleAndScoreParams,
  type Sampler,
  type SamplingResult,
  type UnstructuredSamplingResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TRAIN_IDS = ['train_1', 'train_2', 'train_3'];
const VALIDATION_IDS = ['validation_1', 'validation_2'];

/** A `sampleAndScore` call with every optional parameter resolved. */
interface ResolvedCall {
  candidateName: string;
  exampleSet: ExampleSet;
  batch: string[];
  captureFullEvalData: boolean;
}

/** An `AgentWithScores` carrying an optimizer-specific metric. */
interface ScoredAgentWithLatency extends AgentWithScores {
  latencyMs: number;
}

/** Scores an example UID deterministically, so assertions stay stable. */
function scoreOf(uid: string): number {
  return Number(uid.slice(-1));
}

/** Reads only the base contract, so it accepts any `SamplingResult`. */
function meanScore(result: SamplingResult): number {
  const values = Object.values(result.scores);
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * A `Sampler` that records the parameters of every call, with the documented
 * defaults applied.
 */
class RecordingSampler implements Sampler<UnstructuredSamplingResult> {
  readonly calls: ResolvedCall[] = [];

  getTrainExampleIds(): string[] {
    return [...TRAIN_IDS];
  }

  getValidationExampleIds(): string[] {
    return [...VALIDATION_IDS];
  }

  async sampleAndScore(
    params: SampleAndScoreParams,
  ): Promise<UnstructuredSamplingResult> {
    const exampleSet = params.exampleSet ?? 'validation';
    const batch =
      params.batch ??
      (exampleSet === 'train'
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const captureFullEvalData = params.captureFullEvalData ?? false;
    this.calls.push({
      candidateName: params.candidate.name,
      exampleSet,
      batch,
      captureFullEvalData,
    });

    const result: UnstructuredSamplingResult = {
      scores: Object.fromEntries(batch.map((uid) => [uid, scoreOf(uid)])),
    };
    if (captureFullEvalData) {
      result.data = Object.fromEntries(
        batch.map((uid) => [uid, {trajectory: [`${uid}:tool_call`]}]),
      );
    }
    return result;
  }
}

/** An optimizer that trains on one batch, then validates several variants. */
class FakeOptimizer implements AgentOptimizer<
  UnstructuredSamplingResult,
  ScoredAgentWithLatency
> {
  constructor(private readonly variantNames: string[]) {}

  async optimize(
    initialAgent: LlmAgent,
    sampler: Sampler<UnstructuredSamplingResult>,
  ): Promise<OptimizerResult<ScoredAgentWithLatency>> {
    const trainIds = sampler.getTrainExampleIds();
    await sampler.sampleAndScore({
      candidate: initialAgent,
      exampleSet: 'train',
      batch: trainIds.slice(0, 2),
      captureFullEvalData: true,
    });

    const validationIds = sampler.getValidationExampleIds();
    const optimizedAgents: ScoredAgentWithLatency[] = [];
    for (const [index, name] of this.variantNames.entries()) {
      const candidate = new LlmAgent({
        name,
        description: `variant ${index} of ${initialAgent.name}`,
      });
      const scored = await sampler.sampleAndScore({
        candidate,
        exampleSet: 'validation',
        batch: validationIds,
      });
      optimizedAgents.push({
        optimizedAgent: candidate,
        overallScore: meanScore(scored),
        latencyMs: 100 + index,
      });
    }
    return {optimizedAgents};
  }
}

function newInitialAgent(): LlmAgent {
  return new LlmAgent({name: 'initial_agent', description: 'the seed agent'});
}

describe('optimization contract', () => {
  describe('AgentOptimizer.optimize', () => {
    it('returns a Pareto front of scored agents', async () => {
      const optimizer = new FakeOptimizer(['variant_a', 'variant_b']);

      const result: OptimizerResult<ScoredAgentWithLatency> =
        await optimizer.optimize(newInitialAgent(), new RecordingSampler());

      expect(result.optimizedAgents.length).toBeGreaterThan(1);
      for (const entry of result.optimizedAgents) {
        expect(isLlmAgent(entry.optimizedAgent)).toBe(true);
        expect(typeof entry.overallScore).toBe('number');
      }
      expect(
        result.optimizedAgents.map((entry) => entry.optimizedAgent.name),
      ).toEqual(['variant_a', 'variant_b']);
    });

    it('samples the train set before the validation set', async () => {
      const sampler = new RecordingSampler();

      await new FakeOptimizer(['variant_a']).optimize(
        newInitialAgent(),
        sampler,
      );

      expect(sampler.calls).toEqual([
        {
          candidateName: 'initial_agent',
          exampleSet: 'train',
          batch: ['train_1', 'train_2'],
          captureFullEvalData: true,
        },
        {
          candidateName: 'variant_a',
          exampleSet: 'validation',
          batch: ['validation_1', 'validation_2'],
          captureFullEvalData: false,
        },
      ]);
    });

    it('threads a custom AgentWithScores subtype through the result', async () => {
      const result = await new FakeOptimizer([
        'variant_a',
        'variant_b',
      ]).optimize(newInitialAgent(), new RecordingSampler());

      expect(result.optimizedAgents.map((entry) => entry.latencyMs)).toEqual([
        100, 101,
      ]);
    });
  });

  // An interface cannot enforce a default, so these cases pin the defaults
  // that `SampleAndScoreParams` documents for implementations.
  describe('Sampler.sampleAndScore', () => {
    it('accepts a call that omits every optional parameter', async () => {
      const sampler = new RecordingSampler();

      const result = await sampler.sampleAndScore({
        candidate: newInitialAgent(),
      });

      expect(sampler.calls).toEqual([
        {
          candidateName: 'initial_agent',
          exampleSet: 'validation',
          batch: VALIDATION_IDS,
          captureFullEvalData: false,
        },
      ]);
      expect(result.data).toBeUndefined();
    });

    it('scores the requested batch and widens a plain SamplingResult', async () => {
      const sampler: Sampler<UnstructuredSamplingResult> =
        new RecordingSampler();

      const result = await sampler.sampleAndScore({
        candidate: newInitialAgent(),
        exampleSet: 'train',
        batch: ['train_1', 'train_3'],
        captureFullEvalData: true,
      });

      expect(Object.keys(result.scores)).toEqual(['train_1', 'train_3']);
      expect(Object.values(result.scores)).toEqual([
        scoreOf('train_1'),
        scoreOf('train_3'),
      ]);
      expect(Object.keys(result.data ?? {})).toEqual(['train_1', 'train_3']);

      const base: SamplingResult = result;
      expect(meanScore(base)).toBe(2);
    });
  });
});
