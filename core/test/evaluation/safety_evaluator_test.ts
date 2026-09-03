/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  Invocation,
  PrebuiltMetrics,
  SafetyEvaluatorV1,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function invocation(query: string, response: string): Invocation {
  return {
    invocationId: '',
    userContent: {parts: [{text: query}]},
    finalResponse: {parts: [{text: response}]},
    creationTimestamp: 0,
  };
}

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

describe('SafetyEvaluatorV1', () => {
  it('scores a safe response and requests the SAFETY metric', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.8},
      evalClient,
    });

    const result = await evaluator.evaluateInvocations(
      [invocation('Tell me a joke.', 'Why did the chicken cross the road?')],
      [invocation('Tell me a joke.', 'A safe joke.')],
    );

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(evalClient.requests).toHaveLength(1);
    expect(evalClient.requests[0].metrics).toEqual([{name: 'SAFETY'}]);
  });

  it('fails a response scored below the threshold', async () => {
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.8},
      evalClient: new FakeEvalClient([scored(0.5)]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('reports not evaluated when the service returns no score', async () => {
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.8},
      evalClient: new FakeEvalClient([{summaryMetrics: []}]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toHaveLength(1);
  });

  it('scores without expected invocations and sends no reference', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.8},
      evalClient,
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[0].expectedInvocation).toBeUndefined();
    expect(evalClient.requests[0].dataset.evalDataset[0]).toEqual({
      prompt: 'q',
      reference: undefined,
      response: 'a',
    });
  });

  it('sends empty text for a turn with no final response', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.8},
      evalClient,
    });

    await evaluator.evaluateInvocations([
      {userContent: {parts: [{text: 'q'}, {thought: true}]}},
    ]);

    expect(evalClient.requests[0].dataset.evalDataset[0]).toEqual({
      prompt: 'q',
      reference: undefined,
      response: '',
    });
  });

  it('reads the threshold from the criterion', async () => {
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {
        metricName: PrebuiltMetrics.SAFETY_V1,
        criterion: {threshold: 0.95},
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('reads the deprecated metric-level threshold', async () => {
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.8},
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('prefers the criterion threshold over the deprecated one', async () => {
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {
        metricName: PrebuiltMetrics.SAFETY_V1,
        threshold: 0.8,
        criterion: {threshold: 0.95},
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('rejects a metric that carries no threshold', () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);

    expect(
      () =>
        new SafetyEvaluatorV1({
          evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1},
          evalClient,
        }),
    ).toThrow("Evaluation metric 'safety_v1' requires a threshold.");
    expect(evalClient.requests).toHaveLength(0);
  });

  it('rejects invocation lists of different lengths', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.8},
      evalClient,
    });

    await expect(
      evaluator.evaluateInvocations(
        [invocation('q', 'a'), invocation('q2', 'a2')],
        [invocation('q', 'a')],
      ),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length;' +
        ' got 2 and 1.',
    );
    expect(evalClient.requests).toHaveLength(0);
  });

  it('averages the scores of several invocations', async () => {
    const evalClient = new FakeEvalClient([scored(0.9), scored(0.5)]);
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.6},
      evalClient,
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q', 'a'),
      invocation('q2', 'a2'),
    ]);

    expect(evalClient.requests).toHaveLength(2);
    expect(evalClient.requests[0].dataset.evalDataset).toHaveLength(1);
    expect(evalClient.requests[1].dataset.evalDataset).toHaveLength(1);
    expect(result.overallScore).toBeCloseTo(0.7);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.PASSED,
      EvalStatus.FAILED,
    ]);
  });

  it('evaluates nothing when there are no invocations', async () => {
    const evalClient = new FakeEvalClient([]);
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.8},
      evalClient,
    });

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
    expect(evalClient.requests).toHaveLength(0);
  });
});
