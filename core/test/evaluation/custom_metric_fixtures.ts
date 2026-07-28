/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ConversationScenario,
  EvalMetric,
  EvaluationResult,
  Invocation,
} from '@google/adk';
import {EvalStatus} from '@google/adk';

/**
 * A synchronous custom metric function used by the custom-metric-evaluator
 * tests. Returns a fixed overall score of 1.0.
 */
export function mySyncMetricFunction(
  evalMetric: EvalMetric,
  actualInvocations: Invocation[],
  expectedInvocations?: Invocation[],
  conversationScenario?: ConversationScenario,
): EvaluationResult {
  void evalMetric;
  void actualInvocations;
  void expectedInvocations;
  void conversationScenario;
  return {
    overallScore: 1.0,
    overallEvalStatus: EvalStatus.PASSED,
    perInvocationResults: [],
  };
}

/**
 * An asynchronous custom metric function used by the custom-metric-evaluator
 * tests. Returns a fixed overall score of 0.5.
 */
export async function myAsyncMetricFunction(
  evalMetric: EvalMetric,
  actualInvocations: Invocation[],
  expectedInvocations?: Invocation[],
  conversationScenario?: ConversationScenario,
): Promise<EvaluationResult> {
  void evalMetric;
  void actualInvocations;
  void expectedInvocations;
  void conversationScenario;
  return {
    overallScore: 0.5,
    overallEvalStatus: EvalStatus.PASSED,
    perInvocationResults: [],
  };
}
