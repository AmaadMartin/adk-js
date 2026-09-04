/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentWithScores,
  createAgentWithScores,
  createOptimizerResult,
  createSamplingResult,
  createUnstructuredSamplingResult,
  InputValidationError,
  LlmAgent,
  OptimizerResult,
  SamplingResult,
  UnstructuredSamplingResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * Untyped views of the factories. A sampler or an optimizer written by a caller
 * is not compiled against these signatures, so its output reaches the factory
 * unchecked. These aliases express that boundary without weakening the data.
 */
const samplingResultFrom = createSamplingResult as (
  value: unknown,
) => SamplingResult;
const unstructuredSamplingResultFrom = createUnstructuredSamplingResult as (
  value: unknown,
) => UnstructuredSamplingResult;
const agentWithScoresFrom = createAgentWithScores as (
  value: unknown,
) => AgentWithScores;
const optimizerResultFrom = createOptimizerResult as (
  value: unknown,
) => OptimizerResult;

/** An optimizer subtype that reports its own metric. */
interface AgentWithCustomMetric extends AgentWithScores {
  promptTokens: number;
}

function newAgent(name = 'test_agent'): LlmAgent {
  return new LlmAgent({name});
}

function expectInputValidationError(fn: () => unknown, message: string): void {
  expect(fn).toThrowError(InputValidationError);
  expect(fn).toThrowError(message);
}

describe('createSamplingResult', () => {
  it('returns a populated scores map', () => {
    const result = createSamplingResult({scores: {train1: 0.8, train2: 0.0}});

    expect(result.scores).toEqual({train1: 0.8, train2: 0.0});
  });

  it('accepts an empty scores map', () => {
    expect(createSamplingResult({scores: {}}).scores).toEqual({});
  });

  it('accepts Infinity and NaN as scores', () => {
    const result = createSamplingResult({
      scores: {best: Infinity, broken: NaN, worst: -Infinity},
    });

    expect(result.scores['best']).toBe(Infinity);
    expect(result.scores['broken']).toBeNaN();
    expect(result.scores['worst']).toBe(-Infinity);
  });

  it('returns the same object it was given', () => {
    const params: SamplingResult = {scores: {train1: 1.0}};

    expect(createSamplingResult(params)).toBe(params);
  });

  it('rejects a missing scores map', () => {
    expectInputValidationError(
      () => samplingResultFrom({}),
      'scores must be an object mapping each example UID to a number.',
    );
  });

  it('rejects a null scores map', () => {
    expectInputValidationError(
      () => samplingResultFrom({scores: null}),
      'scores must be an object mapping each example UID to a number.',
    );
  });

  it('rejects an array as the scores map', () => {
    expectInputValidationError(
      () => samplingResultFrom({scores: [0.5]}),
      'scores must be an object mapping each example UID to a number.',
    );
  });

  it('rejects a string score and names the example UID', () => {
    expectInputValidationError(
      () => samplingResultFrom({scores: {train1: 0.8, train2: '0.5'}}),
      "scores['train2'] must be a number.",
    );
  });
});

describe('createUnstructuredSamplingResult', () => {
  it('leaves data undefined when it is omitted', () => {
    const result = createUnstructuredSamplingResult({scores: {val1: 0.5}});

    expect(result.data).toBeUndefined();
  });

  it('keeps an empty data map distinct from undefined', () => {
    const result = createUnstructuredSamplingResult({
      scores: {val1: 0.5},
      data: {},
    });

    expect(result.data).toEqual({});
  });

  it('accepts the shape gepa_root_agent_optimizer_test.py builds', () => {
    const result = createUnstructuredSamplingResult({
      scores: {train1: 0.8},
      data: {train1: {output: 'result'}},
    });

    expect(result).toEqual({
      scores: {train1: 0.8},
      data: {train1: {output: 'result'}},
    });
  });

  it('accepts the shape local_eval_sampler_test.py asserts', () => {
    const result = createUnstructuredSamplingResult({
      scores: {t1: 1.0, t2: 0.0},
      data: {t1: {}, t2: {}},
    });

    expect(result.scores).toEqual({t1: 1.0, t2: 0.0});
    expect(result.data).toEqual({t1: {}, t2: {}});
  });

  it('rejects a bad scores map before it looks at data', () => {
    expectInputValidationError(
      () =>
        unstructuredSamplingResultFrom({scores: {t1: 'high'}, data: {t1: {}}}),
      "scores['t1'] must be a number.",
    );
  });

  it('rejects a string as the data map', () => {
    expectInputValidationError(
      () => unstructuredSamplingResultFrom({scores: {}, data: 'eval data'}),
      'data must be an object mapping each example UID to an object of evaluation data.',
    );
  });

  it('rejects a null data entry and names the example UID', () => {
    expectInputValidationError(
      () => unstructuredSamplingResultFrom({scores: {}, data: {t1: null}}),
      "data['t1'] must be an object of evaluation data.",
    );
  });

  it('rejects an array data entry', () => {
    expectInputValidationError(
      () =>
        unstructuredSamplingResultFrom({scores: {}, data: {t1: ['step one']}}),
      "data['t1'] must be an object of evaluation data.",
    );
  });
});

describe('createAgentWithScores', () => {
  it('returns the same agent instance it was given', () => {
    const agent = newAgent();

    expect(createAgentWithScores({optimizedAgent: agent}).optimizedAgent).toBe(
      agent,
    );
  });

  it('leaves overallScore undefined when it is omitted', () => {
    const result = createAgentWithScores({optimizedAgent: newAgent()});

    expect(result.overallScore).toBeUndefined();
  });

  it('keeps the extra fields a subtype adds', () => {
    const params: AgentWithCustomMetric = {
      optimizedAgent: newAgent(),
      overallScore: 0.9,
      promptTokens: 1234,
    };

    const result = createAgentWithScores(params);

    expect(result).toBe(params);
    expect(result).toEqual({
      optimizedAgent: params.optimizedAgent,
      overallScore: 0.9,
      promptTokens: 1234,
    });
  });

  it('rejects a plain object as the optimized agent', () => {
    expectInputValidationError(
      () => agentWithScoresFrom({optimizedAgent: {name: 'test_agent'}}),
      'optimizedAgent must be an LlmAgent.',
    );
  });

  it('rejects an undefined optimized agent', () => {
    expectInputValidationError(
      () => agentWithScoresFrom({}),
      'optimizedAgent must be an LlmAgent.',
    );
  });

  it('rejects a string overall score', () => {
    expectInputValidationError(
      () =>
        agentWithScoresFrom({optimizedAgent: newAgent(), overallScore: '0.9'}),
      'overallScore must be a number.',
    );
  });
});

describe('createOptimizerResult', () => {
  it('preserves the order of the optimized agents', () => {
    const first = createAgentWithScores({
      optimizedAgent: newAgent('first'),
      overallScore: 0.9,
    });
    const second = createAgentWithScores({
      optimizedAgent: newAgent('second'),
      overallScore: 0.4,
    });

    const result = createOptimizerResult({optimizedAgents: [first, second]});

    expect(result.optimizedAgents).toEqual([first, second]);
  });

  it('accepts an empty Pareto front', () => {
    expect(
      createOptimizerResult({optimizedAgents: []}).optimizedAgents,
    ).toEqual([]);
  });

  it('carries a subtype through the type parameter', () => {
    const result: OptimizerResult<AgentWithCustomMetric> =
      createOptimizerResult({
        optimizedAgents: [
          {optimizedAgent: newAgent(), overallScore: 0.9, promptTokens: 1234},
        ],
      });

    expect(result.optimizedAgents[0].promptTokens).toBe(1234);
  });

  it('rejects a missing optimizedAgents list', () => {
    expectInputValidationError(
      () => optimizerResultFrom({}),
      'optimizedAgents must be an array.',
    );
  });

  it('rejects an object as the optimizedAgents list', () => {
    expectInputValidationError(
      () => optimizerResultFrom({optimizedAgents: {first: newAgent()}}),
      'optimizedAgents must be an array.',
    );
  });

  it('propagates the inner error when an element is invalid', () => {
    expectInputValidationError(
      () =>
        optimizerResultFrom({
          optimizedAgents: [
            {optimizedAgent: newAgent(), overallScore: 0.9},
            {optimizedAgent: newAgent(), overallScore: 'high'},
          ],
        }),
      'overallScore must be a number.',
    );
  });
});
