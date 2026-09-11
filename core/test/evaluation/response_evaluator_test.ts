/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  Invocation,
  ResponseEvaluator,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A client that returns one canned result and records what it was asked. */
class FakeEvalClient implements VertexAiEvalClient {
  readonly requests: VertexAiEvalRequest[] = [];

  constructor(private readonly result: VertexEvaluationResult) {}

  async evaluate(
    request: VertexAiEvalRequest,
  ): Promise<VertexEvaluationResult> {
    this.requests.push(request);
    return this.result;
  }
}

const actualInvocations: Invocation[] = [
  {
    invocationId: '',
    userContent: {parts: [{text: 'This is a test query.'}]},
    finalResponse: {parts: [{text: 'This is a test candidate response.'}]},
    creationTimestamp: 0,
  },
];

const expectedInvocations: Invocation[] = [
  {
    invocationId: '',
    userContent: {parts: [{text: 'This is a test query.'}]},
    finalResponse: {parts: [{text: 'This is a test reference.'}]},
    creationTimestamp: 0,
  },
];

describe('ResponseEvaluator', () => {
  it('scores the rouge metric locally', async () => {
    const client = new FakeEvalClient({});
    const evaluator = new ResponseEvaluator({
      threshold: 0.8,
      metricName: 'response_match_score',
      evalClient: client,
    });

    const result = await evaluator.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );

    expect(result.overallScore).toBeCloseTo(8 / 11);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(client.requests).toHaveLength(0);
  });

  it('scores the coherence metric with the eval client', async () => {
    const client = new FakeEvalClient({summaryMetrics: [{meanScore: 0.9}]});
    const evaluator = new ResponseEvaluator({
      threshold: 0.8,
      metricName: 'response_evaluation_score',
      evalClient: client,
    });

    const result = await evaluator.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].metrics).toEqual([{name: 'COHERENCE'}]);
  });

  it('fails the coherence metric below the threshold', async () => {
    const client = new FakeEvalClient({summaryMetrics: [{meanScore: 0.5}]});
    const evaluator = new ResponseEvaluator({
      threshold: 0.8,
      metricName: 'response_evaluation_score',
      evalClient: client,
    });

    const result = await evaluator.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('leaves the coherence metric unevaluated when the service returns no score', async () => {
    const client = new FakeEvalClient({summaryMetrics: []});
    const evaluator = new ResponseEvaluator({
      threshold: 0.8,
      metricName: 'response_evaluation_score',
      evalClient: client,
    });

    const result = await evaluator.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toHaveLength(1);
  });

  it('rejects the coherence metric without an eval client', () => {
    expect(
      () =>
        new ResponseEvaluator({
          threshold: 0.8,
          metricName: 'response_evaluation_score',
        }),
    ).toThrow('`response_evaluation_score` requires an evalClient');
  });

  it('takes the threshold and the metric name from an eval metric', async () => {
    const evaluator = new ResponseEvaluator({
      evalMetric: {
        metricName: 'response_match_score',
        criterion: {threshold: 0.7},
      },
    });

    const result = await evaluator.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );

    expect(result.overallScore).toBeCloseTo(8 / 11);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('takes the deprecated threshold of an eval metric', async () => {
    const evaluator = new ResponseEvaluator({
      evalMetric: {metricName: 'response_match_score', threshold: 0.8},
    });

    const result = await evaluator.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('rejects an eval metric given together with a threshold', () => {
    expect(
      () =>
        new ResponseEvaluator({
          threshold: 0.8,
          evalMetric: {metricName: 'response_match_score', threshold: 0.8},
        }),
    ).toThrow(
      'Either evalMetric should be specified or both threshold and metricName should be specified.',
    );
  });

  it('rejects an eval metric given together with a metric name', () => {
    expect(
      () =>
        new ResponseEvaluator({
          metricName: 'response_match_score',
          evalMetric: {metricName: 'response_match_score', threshold: 0.8},
        }),
    ).toThrow(
      'Either evalMetric should be specified or both threshold and metricName should be specified.',
    );
  });

  it('rejects an eval metric that carries no threshold', () => {
    expect(
      () =>
        new ResponseEvaluator({
          evalMetric: {metricName: 'response_match_score'},
        }),
    ).toThrow("Evaluation metric 'response_match_score' requires a threshold.");
  });

  it('rejects options with neither a threshold nor an eval metric', () => {
    expect(() => new ResponseEvaluator({metricName: 'not_a_metric'})).toThrow(
      'A response evaluation threshold is required.',
    );
  });

  it('rejects an unsupported metric name', () => {
    expect(
      () => new ResponseEvaluator({threshold: 0.8, metricName: 'foo'}),
    ).toThrow('`foo` is not supported.');
  });
});
