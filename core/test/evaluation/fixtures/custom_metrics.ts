/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture module that `getMetricFunction` imports by path, standing in for the
 * scoring code an eval config file names.
 */

import {
  EvalStatus,
  type ConversationScenario,
  type EvalMetric,
  type EvaluationResult,
  type Invocation,
} from '@google/adk';

/** The score {@link syncMetric} awards. */
export const SYNC_SCORE = 1.0;

/** The score {@link asyncMetric} awards. */
export const ASYNC_SCORE = 0.5;

/** The score the default export awards. */
export const DEFAULT_EXPORT_SCORE = 0.25;

function passed(overallScore: number): EvaluationResult {
  return {
    overallScore,
    overallEvalStatus: EvalStatus.PASSED,
    perInvocationResults: [],
  };
}

/** A scoring function that returns its verdict directly. */
export function syncMetric(): EvaluationResult {
  return passed(SYNC_SCORE);
}

/** A scoring function that returns a promise of its verdict. */
export async function asyncMetric(): Promise<EvaluationResult> {
  return passed(ASYNC_SCORE);
}

/** What one call to {@link recordingMetric} was handed. */
export interface RecordedCall {
  evalMetric: EvalMetric;
  actualInvocations: Invocation[];
  expectedInvocations?: Invocation[];
  conversationScenario?: ConversationScenario;
}

/** Every call {@link recordingMetric} has received, oldest first. */
export const recordedCalls: RecordedCall[] = [];

/** A scoring function that records its arguments so a test can assert on them. */
export function recordingMetric(
  evalMetric: EvalMetric,
  actualInvocations: Invocation[],
  expectedInvocations?: Invocation[],
  conversationScenario?: ConversationScenario,
): EvaluationResult {
  recordedCalls.push({
    evalMetric,
    actualInvocations,
    expectedInvocations,
    conversationScenario,
  });
  return passed(SYNC_SCORE);
}

/** A scoring function that writes to the metric it was handed. */
export function mutatingMetric(evalMetric: EvalMetric): EvaluationResult {
  evalMetric.metricName = 'rewritten_by_the_function';
  if (evalMetric.criterion) {
    evalMetric.criterion.threshold = 0;
  }
  return passed(SYNC_SCORE);
}

/** An export that is not callable, so resolving it must be refused. */
export const notAFunction = {overallScore: SYNC_SCORE};

export default function defaultMetric(): EvaluationResult {
  return passed(DEFAULT_EXPORT_SCORE);
}
