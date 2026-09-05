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
  MultiTurnTaskSuccessV1Evaluator,
  MultiTurnVertexAiEvalFacade,
  PrebuiltMetrics,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

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

function turn(id: string): Invocation {
  return {
    invocationId: id,
    userContent: {parts: [{text: `q-${id}`}]},
    finalResponse: {parts: [{text: `r-${id}`}]},
  };
}

function scored(meanScore: number): VertexEvaluationResult {
  return {summaryMetrics: [{meanScore}]};
}

const SCENARIO: ConversationScenario = {
  startingPrompt: 'book me a table',
  conversationPlan: 'ask for a table, then change the time',
};

describe('MultiTurnTaskSuccessV1Evaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the threshold from the criterion, not from the deprecated field', async () => {
    const client = new FakeEvalClient([scored(0.6)]);
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.9,
        criterion: {threshold: 0.5},
      },
      evalClient: client,
    });

    const result = await evaluator.evaluateInvocations([turn('inv1')]);

    // 0.6 clears the criterion threshold of 0.5 and misses the deprecated 0.9.
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('falls back to the deprecated threshold when there is no criterion', async () => {
    const client = new FakeEvalClient([scored(0.6)]);
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.9,
      },
      evalClient: client,
    });

    const result = await evaluator.evaluateInvocations([turn('inv1')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('passes a score equal to the threshold and fails one just below it', async () => {
    const threshold = 0.8;
    for (const [score, expected] of [
      [threshold, EvalStatus.PASSED],
      [threshold - Number.EPSILON, EvalStatus.FAILED],
    ] as const) {
      const client = new FakeEvalClient([scored(score)]);
      const evaluator = new MultiTurnTaskSuccessV1Evaluator({
        evalMetric: {
          metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
          criterion: {threshold},
        },
        evalClient: client,
      });

      const result = await evaluator.evaluateInvocations([turn('inv1')]);

      expect(result.overallScore).toBe(score);
      expect(result.overallEvalStatus).toBe(expected);
    }
  });

  it('rejects a metric that carries no threshold at all', () => {
    expect(
      () =>
        new MultiTurnTaskSuccessV1Evaluator({
          evalMetric: {
            metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
          },
          evalClient: new FakeEvalClient([]),
        }),
    ).toThrow(InputValidationError);
    expect(
      () =>
        new MultiTurnTaskSuccessV1Evaluator({
          evalMetric: {
            metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
          },
          evalClient: new FakeEvalClient([]),
        }),
    ).toThrow(
      "Evaluation metric 'multi_turn_task_success_v1' requires a threshold.",
    );
  });

  it('forwards the conversation scenario to the facade', async () => {
    const forward = vi.spyOn(
      MultiTurnVertexAiEvalFacade.prototype,
      'evaluateInvocations',
    );
    const client = new FakeEvalClient([scored(0.9)]);
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: client,
    });
    const actual = [turn('inv1')];
    const expected = [turn('golden1')];

    await evaluator.evaluateInvocations(actual, expected, SCENARIO);

    expect(forward).toHaveBeenCalledWith(actual, expected, SCENARIO);
  });

  it('sends the same request whether or not a scenario is given', async () => {
    const withScenario = new FakeEvalClient([scored(0.9)]);
    const withoutScenario = new FakeEvalClient([scored(0.9)]);
    const evalMetric = {
      metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
      criterion: {threshold: 0.8},
    };

    await new MultiTurnTaskSuccessV1Evaluator({
      evalMetric,
      evalClient: withScenario,
    }).evaluateInvocations([turn('inv1')], undefined, SCENARIO);
    await new MultiTurnTaskSuccessV1Evaluator({
      evalMetric,
      evalClient: withoutScenario,
    }).evaluateInvocations([turn('inv1')]);

    expect(withScenario.requests).toEqual(withoutScenario.requests);
  });

  it('evaluates nothing and calls no service for an empty conversation', async () => {
    const client = new FakeEvalClient([]);
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: client,
    });

    const result = await evaluator.evaluateInvocations([]);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(client.requests).toHaveLength(0);
  });

  it('rejects golden invocations of a different length', async () => {
    const client = new FakeEvalClient([]);
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: client,
    });

    await expect(
      evaluator.evaluateInvocations(
        [turn('inv1'), turn('inv2')],
        [turn('golden1')],
      ),
    ).rejects.toThrow(InputValidationError);
    expect(client.requests).toHaveLength(0);
  });

  it('evaluates nothing when the service reports no summary metrics', async () => {
    const client = new FakeEvalClient([{}]);
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: client,
    });

    const result = await evaluator.evaluateInvocations([turn('inv1')]);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(client.requests).toHaveLength(1);
  });

  it('scores only the last turn of a three-turn conversation', async () => {
    const client = new FakeEvalClient([scored(0.9)]);
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: client,
    });
    const actual = [turn('inv1'), turn('inv2'), turn('inv3')];
    const expected = [turn('golden1'), turn('golden2'), turn('golden3')];

    const result = await evaluator.evaluateInvocations(actual, expected);

    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.NOT_EVALUATED,
      EvalStatus.NOT_EVALUATED,
      EvalStatus.PASSED,
    ]);
    expect(result.perInvocationResults.map((r) => r.score)).toEqual([
      undefined,
      undefined,
      0.9,
    ]);
    expect(result.perInvocationResults.map((r) => r.actualInvocation)).toEqual(
      actual,
    );
    expect(
      result.perInvocationResults.map((r) => r.expectedInvocation),
    ).toEqual(expected);
    expect(client.requests).toHaveLength(1);
  });
});
