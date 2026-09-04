/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `core/src/optimization/agent_optimizer.ts`,
 * `core/src/optimization/sampler.ts` and
 * `core/src/optimization/data_types.ts`.
 *
 * These port `src/google/adk/optimization/{agent_optimizer,sampler,
 * data_types}.py` from google/adk-python (commit `a3bd1115`). That repository
 * has no test for those three modules, so nothing is ported one-to-one. The
 * fake sampler below reproduces the `mock_sampler` fixture in
 * `tests/unittests/optimization/simple_prompt_optimizer_test.py`, which is the
 * only executable statement upstream makes about how this contract is driven.
 */

import {
  AgentOptimizer,
  AgentWithScores,
  LlmAgent,
  OptimizeParams,
  OptimizerResult,
  SampleAndScoreParams,
  Sampler,
  UnstructuredSamplingResult,
  isAgentOptimizer,
  isSampler,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TRAIN_EXAMPLE_IDS = ['1', '2', '3', '4', '5'];
const VALIDATION_EXAMPLE_IDS = ['v1', 'v2'];
const IMPROVED_INSTRUCTION = 'IMPROVED PROMPT';
const IMPROVED_SCORE = 0.9;
const BASELINE_SCORE = 0.5;

/**
 * A sampler that scores an "improved" instruction higher, and records every
 * call it received.
 */
class FakeSampler extends Sampler<UnstructuredSamplingResult> {
  readonly calls: SampleAndScoreParams[] = [];

  override getTrainExampleIds(): string[] {
    return [...TRAIN_EXAMPLE_IDS];
  }

  override getValidationExampleIds(): string[] {
    return [...VALIDATION_EXAMPLE_IDS];
  }

  override async sampleAndScore({
    candidate,
    exampleSet = Sampler.VALIDATION_SET,
    batch,
    captureFullEvalData = false,
  }: SampleAndScoreParams): Promise<UnstructuredSamplingResult> {
    this.calls.push({candidate, exampleSet, batch, captureFullEvalData});

    const ids =
      batch ??
      (exampleSet === Sampler.TRAIN_SET
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const score =
      candidate.instruction === IMPROVED_INSTRUCTION
        ? IMPROVED_SCORE
        : BASELINE_SCORE;

    const result: UnstructuredSamplingResult = {
      scores: Object.fromEntries(ids.map((id) => [id, score])),
    };
    if (captureFullEvalData) {
      result.data = Object.fromEntries(
        ids.map((id) => [id, {instruction: candidate.instruction}]),
      );
    }
    return result;
  }
}

/** An optimizer result that carries a metric the base shape does not have. */
interface AgentWithLatency extends AgentWithScores {
  latencyMs: number;
}

/**
 * A hill climb over one rewrite: score the initial agent, score an improved
 * candidate, and return the better of the two.
 */
class FakeOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithLatency
> {
  override async optimize({
    initialAgent,
    sampler,
  }: OptimizeParams<UnstructuredSamplingResult>): Promise<
    OptimizerResult<AgentWithLatency>
  > {
    const candidate = new LlmAgent({
      name: initialAgent.name,
      instruction: IMPROVED_INSTRUCTION,
    });
    const candidates = [initialAgent, candidate];

    const scored: AgentWithLatency[] = [];
    for (const [index, agent] of candidates.entries()) {
      const {scores} = await sampler.sampleAndScore({
        candidate: agent,
        exampleSet: Sampler.TRAIN_SET,
      });
      const values = Object.values(scores);
      scored.push({
        optimizedAgent: agent,
        overallScore: values.reduce((a, b) => a + b, 0) / values.length,
        latencyMs: index,
      });
    }

    scored.sort((a, b) => (b.overallScore ?? 0) - (a.overallScore ?? 0));
    return {optimizedAgents: [scored[0]]};
  }
}

/** An optimizer that returns a Pareto front rather than a single winner. */
class ParetoFrontOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  override async optimize({
    initialAgent,
    sampler,
  }: OptimizeParams<UnstructuredSamplingResult>): Promise<
    OptimizerResult<AgentWithScores>
  > {
    const front = ['fast', 'thorough'].map(
      (variant) =>
        new LlmAgent({
          name: `${initialAgent.name}_${variant}`,
          instruction: `${initialAgent.instruction} (${variant})`,
        }),
    );

    const optimizedAgents: AgentWithScores[] = [];
    for (const agent of front) {
      const {scores} = await sampler.sampleAndScore({candidate: agent});
      optimizedAgents.push({
        optimizedAgent: agent,
        overallScore: Object.values(scores)[0],
      });
    }
    return {optimizedAgents};
  }
}

function createInitialAgent(): LlmAgent {
  return new LlmAgent({name: 'test_agent', instruction: 'Initial Prompt'});
}

describe('Sampler', () => {
  it('pins the two example set names shared with adk-python', () => {
    expect(Sampler.TRAIN_SET).toBe('train');
    expect(Sampler.VALIDATION_SET).toBe('validation');
  });

  it('scores the validation ids when exampleSet is omitted', async () => {
    const sampler = new FakeSampler();

    const result = await sampler.sampleAndScore({
      candidate: createInitialAgent(),
    });

    expect(Object.keys(result.scores)).toEqual(VALIDATION_EXAMPLE_IDS);
    expect(sampler.calls[0].exampleSet).toBe('validation');
  });

  it('scores the train ids when exampleSet is the train set', async () => {
    const sampler = new FakeSampler();

    const result = await sampler.sampleAndScore({
      candidate: createInitialAgent(),
      exampleSet: Sampler.TRAIN_SET,
    });

    expect(Object.keys(result.scores)).toEqual(TRAIN_EXAMPLE_IDS);
    expect(sampler.calls[0].exampleSet).toBe('train');
  });

  it('scores an explicit batch instead of either set', async () => {
    const sampler = new FakeSampler();

    const result = await sampler.sampleAndScore({
      candidate: createInitialAgent(),
      exampleSet: Sampler.TRAIN_SET,
      batch: ['3'],
    });

    expect(Object.keys(result.scores)).toEqual(['3']);
    expect(result.scores['3']).toBe(BASELINE_SCORE);
  });

  it('scores an improved candidate higher', async () => {
    const sampler = new FakeSampler();

    const result = await sampler.sampleAndScore({
      candidate: new LlmAgent({
        name: 'test_agent',
        instruction: IMPROVED_INSTRUCTION,
      }),
      batch: ['1'],
    });

    expect(result.scores['1']).toBe(IMPROVED_SCORE);
  });

  it('populates data only when captureFullEvalData is true', async () => {
    const sampler = new FakeSampler();
    const candidate = createInitialAgent();

    const captured = await sampler.sampleAndScore({
      candidate,
      batch: ['v1'],
      captureFullEvalData: true,
    });
    const notCaptured = await sampler.sampleAndScore({
      candidate,
      batch: ['v1'],
    });

    expect(captured.data).toEqual({v1: {instruction: 'Initial Prompt'}});
    expect(notCaptured.data).toBeUndefined();
  });
});

describe('AgentOptimizer', () => {
  it('drives the sampler and returns the better candidate', async () => {
    const sampler = new FakeSampler();
    const initialAgent = createInitialAgent();

    const result = await new FakeOptimizer().optimize({initialAgent, sampler});

    expect(result.optimizedAgents).toHaveLength(1);
    const [best] = result.optimizedAgents;
    expect(best.optimizedAgent.instruction).toBe(IMPROVED_INSTRUCTION);
    expect(best.overallScore).toBe(IMPROVED_SCORE);
    expect(sampler.calls).toHaveLength(2);
    expect(sampler.calls[0].candidate).toBe(initialAgent);
    expect(sampler.calls[0].exampleSet).toBe('train');
  });

  it('carries a metric that the base result shape does not declare', async () => {
    const sampler = new FakeSampler();

    const result = await new FakeOptimizer().optimize({
      initialAgent: createInitialAgent(),
      sampler,
    });

    expect(result.optimizedAgents[0].latencyMs).toBe(1);
  });

  it('leaves the initial agent unchanged', async () => {
    const sampler = new FakeSampler();
    const initialAgent = createInitialAgent();

    await new FakeOptimizer().optimize({initialAgent, sampler});

    expect(initialAgent.instruction).toBe('Initial Prompt');
  });

  it('returns every agent on a Pareto front', async () => {
    const sampler = new FakeSampler();

    const result = await new ParetoFrontOptimizer().optimize({
      initialAgent: createInitialAgent(),
      sampler,
    });

    expect(
      result.optimizedAgents.map(({optimizedAgent}) => optimizedAgent.name),
    ).toEqual(['test_agent_fast', 'test_agent_thorough']);
    expect(
      result.optimizedAgents.every(
        ({overallScore}) => overallScore === BASELINE_SCORE,
      ),
    ).toBe(true);
  });
});

describe('isSampler', () => {
  it('accepts a Sampler subclass instance', () => {
    expect(isSampler(new FakeSampler())).toBe(true);
  });

  it('rejects a value that is not a Sampler', () => {
    expect(isSampler(undefined)).toBe(false);
    expect(isSampler(null)).toBe(false);
    expect(isSampler({})).toBe(false);
  });

  it('rejects a plain object with the same method names', () => {
    const lookalike = {
      getTrainExampleIds: () => [],
      getValidationExampleIds: () => [],
      sampleAndScore: async () => ({scores: {}}),
    };

    expect(isSampler(lookalike)).toBe(false);
  });

  it('accepts a sampler built by another copy of the package', () => {
    const fromOtherCopy = {[Symbol.for('google.adk.sampler')]: true};

    expect(isSampler(fromOtherCopy)).toBe(true);
  });
});

describe('isAgentOptimizer', () => {
  it('accepts an AgentOptimizer subclass instance', () => {
    expect(isAgentOptimizer(new FakeOptimizer())).toBe(true);
  });

  it('rejects a value that is not an AgentOptimizer', () => {
    expect(isAgentOptimizer(undefined)).toBe(false);
    expect(isAgentOptimizer(null)).toBe(false);
    expect(isAgentOptimizer({})).toBe(false);
  });

  it('rejects a plain object with the same method names', () => {
    const lookalike = {optimize: async () => ({optimizedAgents: []})};

    expect(isAgentOptimizer(lookalike)).toBe(false);
  });

  it('rejects a Sampler', () => {
    expect(isAgentOptimizer(new FakeSampler())).toBe(false);
  });

  it('accepts an optimizer built by another copy of the package', () => {
    const fromOtherCopy = {[Symbol.for('google.adk.agentOptimizer')]: true};

    expect(isAgentOptimizer(fromOtherCopy)).toBe(true);
  });
});
