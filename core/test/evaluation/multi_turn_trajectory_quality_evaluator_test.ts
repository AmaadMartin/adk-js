/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  EvaluationDataset,
  Invocation,
  Metric,
  MultiTurnTrajectoryQualityV1Evaluator,
  MultiTurnVertexAiEvalFacade,
  RubricMetric,
  VertexEvaluationResult,
} from '@google/adk';
import {Content} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

type PerformEval = (
  dataset: EvaluationDataset,
  metrics: Metric[],
) => VertexEvaluationResult;

function content(text: string): Content {
  return {parts: [{text}]};
}

function invocations(): Invocation[] {
  return [
    {
      invocationId: 'inv1',
      userContent: content('q1'),
      finalResponse: content('r1'),
    },
    {
      invocationId: 'inv2',
      userContent: content('q2'),
      finalResponse: content('r2'),
    },
  ];
}

function stubPerformEval(meanScore: number) {
  return vi
    .spyOn(
      MultiTurnVertexAiEvalFacade.prototype as unknown as {
        performEval: PerformEval;
      },
      'performEval',
    )
    .mockReturnValue({summaryMetrics: [{meanScore}]});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MultiTurnTrajectoryQualityV1Evaluator', () => {
  it('delegates to the multi-turn trajectory quality metric (passed)', () => {
    const spy = stubPerformEval(0.9);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      metricName: 'multi_turn_trajectory_quality',
      threshold: 0.8,
    });

    const result = evaluator.evaluateInvocations(invocations());

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1].map((m) => m.name)).toEqual([
      RubricMetric.MULTI_TURN_TRAJECTORY_QUALITY.name,
    ]);
  });

  it('reports FAILED when the score is below the threshold', () => {
    stubPerformEval(0.7);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      metricName: 'multi_turn_trajectory_quality',
      threshold: 0.8,
    });

    const result = evaluator.evaluateInvocations(invocations());

    expect(result.overallScore).toBe(0.7);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });
});
