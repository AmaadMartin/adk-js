/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  InputValidationError,
  MetricEvaluatorRegistry,
  NotFoundError,
  PrebuiltMetrics,
  defaultMetricEvaluatorRegistry,
  emptyEvaluationResult,
  type EvalMetric,
  type EvaluationResult,
  type Evaluator,
  type Invocation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const THRESHOLD = 0.5;

function metric(metricName: string): EvalMetric {
  return {metricName, threshold: THRESHOLD};
}

/** An invocation that called `get_weather` and answered `sunny`. */
function invocation(): Invocation {
  return {
    invocationId: 'invocation_1',
    userContent: {parts: [{text: 'What is the weather?'}]},
    finalResponse: {parts: [{text: 'sunny'}]},
    intermediateData: {
      toolUses: [{name: 'get_weather', args: {city: 'Seattle'}}],
      toolResponses: [],
      intermediateResponses: [],
    },
    creationTimestamp: 0,
  };
}

/** An evaluator that reports nothing, used to check what is registered. */
class StubEvaluator implements Evaluator {
  evaluateInvocations(): EvaluationResult {
    return emptyEvaluationResult();
  }
}

describe('MetricEvaluatorRegistry', () => {
  it('resolves tool_trajectory_avg_score to a trajectory evaluator', async () => {
    const registry = new MetricEvaluatorRegistry();

    const evaluator = registry.getEvaluator(
      metric(PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE),
    );
    const result = await evaluator.evaluateInvocations(
      [invocation()],
      [invocation()],
    );

    expect(result.overallScore).toBe(1);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('resolves response_match_score to a response evaluator', async () => {
    const registry = new MetricEvaluatorRegistry();

    const evaluator = registry.getEvaluator(
      metric(PrebuiltMetrics.RESPONSE_MATCH_SCORE),
    );
    const result = await evaluator.evaluateInvocations(
      [invocation()],
      [invocation()],
    );

    expect(result.overallScore).toBe(1);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('resolves response_evaluation_score, which then asks for its client', () => {
    const registry = new MetricEvaluatorRegistry();

    expect(() =>
      registry.getEvaluator(metric(PrebuiltMetrics.RESPONSE_EVALUATION_SCORE)),
    ).toThrow(InputValidationError);
  });

  it('returns a new evaluator for every call', () => {
    const registry = new MetricEvaluatorRegistry();
    const evalMetric = metric(PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE);

    expect(registry.getEvaluator(evalMetric)).not.toBe(
      registry.getEvaluator(evalMetric),
    );
  });

  it('rejects a metric it has no evaluator for', () => {
    const registry = new MetricEvaluatorRegistry();

    expect(() => registry.getEvaluator(metric('unknown_metric'))).toThrow(
      new NotFoundError('unknown_metric not found in registry.'),
    );
  });

  it('resolves a metric registered by the caller', () => {
    const registry = new MetricEvaluatorRegistry();
    const evaluator = new StubEvaluator();

    registry.registerEvaluator('custom_metric', () => evaluator);

    expect(registry.getEvaluator(metric('custom_metric'))).toBe(evaluator);
  });

  it('replaces the evaluator already registered under a name', async () => {
    const registry = new MetricEvaluatorRegistry();
    const evaluator = new StubEvaluator();

    registry.registerEvaluator(
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
      () => evaluator,
    );

    expect(
      registry.getEvaluator(metric(PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE)),
    ).toBe(evaluator);
  });

  it('keeps a registration out of another registry', () => {
    const registry = new MetricEvaluatorRegistry();
    const other = new MetricEvaluatorRegistry();

    registry.registerEvaluator('custom_metric', () => new StubEvaluator());

    expect(() => other.getEvaluator(metric('custom_metric'))).toThrow(
      NotFoundError,
    );
  });

  it('passes the metric to the factory', () => {
    const registry = new MetricEvaluatorRegistry();
    const seen: EvalMetric[] = [];
    const evalMetric = metric('custom_metric');

    registry.registerEvaluator('custom_metric', (given) => {
      seen.push(given);
      return new StubEvaluator();
    });
    registry.getEvaluator(evalMetric);

    expect(seen).toEqual([evalMetric]);
  });
});

describe('defaultMetricEvaluatorRegistry', () => {
  it('returns the same registry every time', () => {
    expect(defaultMetricEvaluatorRegistry()).toBe(
      defaultMetricEvaluatorRegistry(),
    );
  });
});
