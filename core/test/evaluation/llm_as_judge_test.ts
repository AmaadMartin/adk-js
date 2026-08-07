/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AutoRaterScore,
  BaseCriterionSchema,
  BaseLlm,
  EvalMetric,
  EvalStatus,
  EvaluationResult,
  Invocation,
  InvocationSchema,
  LlmAsAJudgeCriterion,
  LlmAsAJudgeCriterionSchema,
  LlmAsJudge,
  LLMRegistry,
  LlmResponse,
  PerInvocationResult,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

/** A BaseLlm that yields the configured responses, one per generate call. */
class MockJudge extends BaseLlm {
  private callIndex = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'mock-judge'});
  }

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const response = this.responses[this.callIndex % this.responses.length];
    this.callIndex += 1;
    if (response !== undefined) {
      yield response;
    }
  }

  override connect(): Promise<never> {
    throw new Error('not implemented');
  }
}

/** A minimal concrete LlmAsJudge used to exercise the base evaluation loop. */
class MockLlmAsJudge extends LlmAsJudge<LlmAsAJudgeCriterion> {
  constructor(evalMetric: EvalMetric) {
    super(evalMetric, LlmAsAJudgeCriterionSchema, 'LlmAsAJudgeCriterion');
  }

  override formatAutoRaterPrompt(): string {
    return 'formatted prompt';
  }

  override convertAutoRaterResponseToScore(): AutoRaterScore {
    return {score: 1.0};
  }

  override aggregatePerInvocationSamples(
    perInvocationSamples: PerInvocationResult[],
  ): PerInvocationResult {
    return perInvocationSamples[0];
  }

  override aggregateInvocationResults(): EvaluationResult {
    return {
      overallScore: 1.0,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: [],
    };
  }
}

function makeMetric(
  overrides: {judgeModel?: string; metricThreshold?: number} = {},
): EvalMetric {
  const criterion = LlmAsAJudgeCriterionSchema.parse({
    threshold: 0.5,
    judgeModelOptions: {
      judgeModel: overrides.judgeModel ?? 'gemini-2.5-flash',
      judgeModelConfig: {},
      numSamples: 3,
    },
  });
  return {
    metricName: 'test_metric',
    threshold: overrides.metricThreshold,
    criterion,
  };
}

function autoRaterResponse(): LlmResponse {
  return {content: {parts: [{text: 'auto rater response'}]}};
}

function makeInvocation(id: string, text: string): Invocation {
  return InvocationSchema.parse({
    invocationId: id,
    userContent: {parts: [{text}], role: 'user'},
    finalResponse: {parts: [{text}], role: 'model'},
  });
}

describe('LlmAsJudge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when the criterion is missing', () => {
    expect(
      () => new MockLlmAsJudge({metricName: 'test_metric', threshold: 0.8}),
    ).toThrow();
  });

  it('throws when the criterion fails schema validation', () => {
    expect(
      () =>
        new MockLlmAsJudge({
          metricName: 'test_metric',
          threshold: 0.8,
          criterion: BaseCriterionSchema.parse({
            threshold: 0.5,
            judgeModelOptions: {numSamples: 'not-a-number'},
          }),
        }),
    ).toThrow();
  });

  it('throws when the judge model is unregistered', () => {
    expect(
      () => new MockLlmAsJudge(makeMetric({judgeModel: 'unregistered_model'})),
    ).toThrow(/not found/);
  });

  it('samples the judge and aggregates across invocations', async () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
      new MockJudge([autoRaterResponse()]),
    );
    const evaluator = new MockLlmAsJudge(makeMetric({metricThreshold: 0.5}));
    const formatSpy = vi.spyOn(evaluator, 'formatAutoRaterPrompt');
    const convertSpy = vi.spyOn(evaluator, 'convertAutoRaterResponseToScore');
    const aggregateSpy = vi.spyOn(evaluator, 'aggregateInvocationResults');

    const actualInvocations = [
      makeInvocation('id1', 'user content 1'),
      makeInvocation('id2', 'user content 2'),
    ];
    const expectedInvocations = [
      makeInvocation('id1', 'expected response 1'),
      makeInvocation('id2', 'expected response 2'),
    ];

    const result = await evaluator.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );

    expect(result.overallScore).toBe(1.0);
    // format once per invocation.
    expect(formatSpy).toHaveBeenCalledTimes(2);
    // convert numSamples (3) times per invocation.
    expect(convertSpy).toHaveBeenCalledTimes(6);
    expect(aggregateSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves the threshold from the criterion when the metric omits it', async () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
      new MockJudge([autoRaterResponse()]),
    );
    const evaluator = new MockLlmAsJudge(makeMetric());
    const result = await evaluator.evaluateInvocations([
      makeInvocation('id1', 'user content 1'),
    ]);
    expect(result.overallScore).toBe(1.0);
  });

  it('returns NOT_EVALUATED when the judge produces no samples', async () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(new MockJudge([]));
    const evaluator = new MockLlmAsJudge(makeMetric({metricThreshold: 0.5}));
    const result = await evaluator.evaluateInvocations([
      makeInvocation('id1', 'user content 1'),
    ]);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });
});
