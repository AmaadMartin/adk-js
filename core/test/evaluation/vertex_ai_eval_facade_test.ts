/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  Invocation,
  SingleTurnVertexAiEvalFacade,
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

describe('SingleTurnVertexAiEvalFacade', () => {
  it('rejects a call without expected invocations when the metric needs them', async () => {
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 0.5,
      metricName: 'COHERENCE',
      expectedInvocationsRequired: true,
      client: new FakeEvalClient([]),
    });

    await expect(
      facade.evaluateInvocations([invocation('q', 'a')]),
    ).rejects.toThrow('expectedInvocations is needed by this metric.');
  });

  it('rejects invocation lists of different lengths', async () => {
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 0.5,
      metricName: 'COHERENCE',
      client: new FakeEvalClient([]),
    });

    await expect(
      facade.evaluateInvocations(
        [invocation('q', 'a')],
        [invocation('q', 'a'), invocation('q2', 'a2')],
      ),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length; got 1 and 2.',
    );
  });

  it('sends one request per invocation, with the metric name', async () => {
    const client = new FakeEvalClient([scored(4), scored(2)]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations(
      [invocation('q1', 'a1'), invocation('q2', 'a2')],
      [invocation('q1', 'golden1'), invocation('q2', 'golden2')],
    );

    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]).toEqual({
      dataset: {
        evalDataset: [{prompt: 'q1', reference: 'golden1', response: 'a1'}],
      },
      metrics: [{name: 'COHERENCE'}],
    });
    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.PASSED,
      EvalStatus.FAILED,
    ]);
    expect(result.overallScore).toBe(3);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('omits the reference when no expected invocations are given', async () => {
    const client = new FakeEvalClient([scored(4)]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations([
      invocation('what is the capital of France?', 'Paris.'),
    ]);

    expect(client.requests[0].dataset.evalDataset[0]).toEqual({
      prompt: 'what is the capital of France?',
      reference: undefined,
      response: 'Paris.',
    });
    expect(result.perInvocationResults[0].expectedInvocation).toBeUndefined();
  });

  it('does not score an invocation whose mean score is not a finite number', async () => {
    const client = new FakeEvalClient([
      scored(Number.NaN),
      scored(Number.POSITIVE_INFINITY),
      {summaryMetrics: []},
      {},
    ]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations([
      invocation('q1', 'a1'),
      invocation('q2', 'a2'),
      invocation('q3', 'a3'),
      invocation('q4', 'a4'),
    ]);

    expect(result.perInvocationResults.map((r) => r.score)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toHaveLength(4);
  });

  it('averages over the scored invocations only', async () => {
    const client = new FakeEvalClient([
      scored(4),
      {summaryMetrics: []},
      scored(2),
    ]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations([
      invocation('q1', 'a1'),
      invocation('q2', 'a2'),
      invocation('q3', 'a3'),
    ]);

    expect(result.overallScore).toBe(3);
    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.PASSED,
      EvalStatus.NOT_EVALUATED,
      EvalStatus.FAILED,
    ]);
  });

  it('returns an unevaluated result for empty invocation lists', async () => {
    const client = new FakeEvalClient([]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations([], []);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(client.requests).toHaveLength(0);
  });
});
