/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalStatus, Invocation, RougeEvaluator} from '@google/adk';
import {describe, expect, it} from 'vitest';

function invocation(query: string, response?: string): Invocation {
  return {
    userContent: {parts: [{text: query}]},
    finalResponse:
      response === undefined ? undefined : {parts: [{text: response}]},
  };
}

describe('RougeEvaluator', () => {
  it('rejects a call without expected invocations', async () => {
    const evaluator = new RougeEvaluator({
      metricName: 'response_match_score',
      threshold: 0.5,
    });

    await expect(
      evaluator.evaluateInvocations([invocation('q', 'a')]),
    ).rejects.toThrow('expectedInvocations is required for this metric.');
  });

  it('rejects invocation lists of different lengths', async () => {
    const evaluator = new RougeEvaluator({
      metricName: 'response_match_score',
      threshold: 0.5,
    });

    await expect(
      evaluator.evaluateInvocations(
        [invocation('q', 'a'), invocation('q2', 'a2')],
        [invocation('q', 'a')],
      ),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length; got 2 and 1.',
    );
  });

  it('returns an unevaluated result for empty invocation lists', async () => {
    const evaluator = new RougeEvaluator({
      metricName: 'response_match_score',
      threshold: 0.5,
    });

    const result = await evaluator.evaluateInvocations([], []);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
  });

  it('averages the scores and rates each invocation on its own', async () => {
    const evaluator = new RougeEvaluator({
      metricName: 'response_match_score',
      threshold: 0.5,
    });
    const actual = [
      invocation('q1', 'alpha beta'),
      invocation('q2', 'gamma delta'),
      invocation('q3', 'epsilon zeta'),
    ];
    const expected = [
      invocation('q1', 'alpha beta'),
      invocation('q2', 'gamma delta'),
      invocation('q3', 'nothing shared'),
    ];

    const result = await evaluator.evaluateInvocations(actual, expected);

    expect(result.perInvocationResults.map((r) => r.score)).toEqual([1, 1, 0]);
    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.PASSED,
      EvalStatus.PASSED,
      EvalStatus.FAILED,
    ]);
    expect(result.overallScore).toBeCloseTo(2 / 3);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[0].actualInvocation).toBe(actual[0]);
    expect(result.perInvocationResults[0].expectedInvocation).toBe(expected[0]);
  });

  it('passes an invocation whose score equals the threshold', async () => {
    const evaluator = new RougeEvaluator({
      metricName: 'response_match_score',
      threshold: 1,
    });

    const result = await evaluator.evaluateInvocations(
      [invocation('q', 'alpha beta')],
      [invocation('q', 'alpha beta')],
    );

    expect(result.overallScore).toBe(1);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('scores a missing final response as zero', async () => {
    const evaluator = new RougeEvaluator({
      metricName: 'response_match_score',
      threshold: 0.5,
    });

    const result = await evaluator.evaluateInvocations(
      [invocation('q1', undefined), invocation('q2', 'alpha')],
      [invocation('q1', 'alpha'), invocation('q2', undefined)],
    );

    expect(result.perInvocationResults.map((r) => r.score)).toEqual([0, 0]);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('joins the text parts of a response with newlines and skips the rest', async () => {
    const evaluator = new RougeEvaluator({
      metricName: 'response_match_score',
      threshold: 0.5,
    });
    const actual: Invocation = {
      userContent: {parts: [{text: 'q'}]},
      finalResponse: {
        parts: [
          {text: 'alpha'},
          {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
          {text: 'beta'},
        ],
      },
    };

    const result = await evaluator.evaluateInvocations(
      [actual],
      [invocation('q', 'alpha beta')],
    );

    expect(result.overallScore).toBe(1);
  });

  it('reads the threshold from the criterion of the metric', async () => {
    const evaluator = new RougeEvaluator({
      metricName: 'response_match_score',
      criterion: {threshold: 1},
    });

    const result = await evaluator.evaluateInvocations(
      [invocation('q', 'alpha beta gamma')],
      [invocation('q', 'alpha beta')],
    );

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });
});
