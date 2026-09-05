/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConversationScenario,
  EvalStatus,
  InputValidationError,
  Invocation,
  MultiTurnToolUseQualityV1Evaluator,
  PrebuiltMetrics,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A client that replays the given results, one per call. */
class FakeEvalClient implements VertexAiEvalClient {
  readonly requests: VertexAiEvalRequest[] = [];

  constructor(private readonly results: VertexEvaluationResult[]) {}

  async evaluate(
    request: VertexAiEvalRequest,
  ): Promise<VertexEvaluationResult> {
    this.requests.push(request);
    return this.results[this.requests.length - 1];
  }
}

function scored(meanScore: number): VertexEvaluationResult {
  return {summaryMetrics: [{meanScore}]};
}

function invocation(query: string, response: string): Invocation {
  return {
    userContent: {parts: [{text: query}]},
    finalResponse: {parts: [{text: response}]},
  };
}

const SCENARIO: ConversationScenario = {
  startingPrompt: 'Book me a flight.',
  conversationPlan: 'Ask for a window seat, then confirm.',
};

describe('MultiTurnToolUseQualityV1Evaluator', () => {
  it('fails a conversation scored below the threshold', async () => {
    const evaluator = new MultiTurnToolUseQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([scored(0.5)]),
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
    ]);

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('reports not evaluated when the service returns no score', async () => {
    const evaluator = new MultiTurnToolUseQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([{summaryMetrics: []}]),
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
    ]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('scores only the last turn of a conversation', async () => {
    const evaluator = new MultiTurnToolUseQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
      invocation('q2', 'r2'),
      invocation('q3', 'r3'),
    ]);

    expect(
      result.perInvocationResults.map((perInvocation) => [
        perInvocation.score,
        perInvocation.evalStatus,
      ]),
    ).toEqual([
      [undefined, EvalStatus.NOT_EVALUATED],
      [undefined, EvalStatus.NOT_EVALUATED],
      [0.9, EvalStatus.PASSED],
    ]);
    expect(result.overallScore).toBe(0.9);
  });

  it('prefers the criterion threshold over the deprecated one', async () => {
    const evaluator = new MultiTurnToolUseQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
        threshold: 0.4,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([scored(0.5)]),
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
    ]);

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('rejects a metric that carries no threshold on construction', () => {
    expect(
      () =>
        new MultiTurnToolUseQualityV1Evaluator({
          evalMetric: {
            metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
          },
          evalClient: new FakeEvalClient([scored(0.9)]),
        }),
    ).toThrow(
      new InputValidationError(
        "Evaluation metric 'multi_turn_tool_use_quality_v1' requires a" +
          ' threshold.',
      ),
    );
  });

  it('rejects expected invocations of a different length', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new MultiTurnToolUseQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient,
    });

    await expect(
      evaluator.evaluateInvocations(
        [invocation('q1', 'r1'), invocation('q2', 'r2')],
        [invocation('q1', 'golden1')],
      ),
    ).rejects.toThrow(InputValidationError);
    expect(evalClient.requests).toEqual([]);
  });

  it('forwards a conversation scenario without changing the request', async () => {
    const withScenario = new FakeEvalClient([scored(0.9)]);
    const withoutScenario = new FakeEvalClient([scored(0.9)]);
    const evalMetric = {
      metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
      criterion: {threshold: 0.8},
    };
    const invocations = [invocation('q1', 'r1'), invocation('q2', 'r2')];

    const scenarioResult = await new MultiTurnToolUseQualityV1Evaluator({
      evalMetric,
      evalClient: withScenario,
    }).evaluateInvocations(invocations, undefined, SCENARIO);
    const plainResult = await new MultiTurnToolUseQualityV1Evaluator({
      evalMetric,
      evalClient: withoutScenario,
    }).evaluateInvocations(invocations);

    expect(withScenario.requests).toEqual(withoutScenario.requests);
    expect(scenarioResult).toEqual(plainResult);
  });

  it('pairs every turn with its golden invocation', async () => {
    const expected = [invocation('q1', 'golden1'), invocation('q2', 'golden2')];
    const evaluator = new MultiTurnToolUseQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations(
      [invocation('q1', 'r1'), invocation('q2', 'r2')],
      expected,
    );

    expect(
      result.perInvocationResults.map(
        (perInvocation) => perInvocation.expectedInvocation,
      ),
    ).toEqual(expected);
  });
});
