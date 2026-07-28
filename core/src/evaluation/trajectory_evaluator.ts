/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall} from '@google/genai';
import {isDeepStrictEqual} from 'node:util';

import {ConversationScenario} from './conversation_scenarios.js';
import {getAllToolCalls, Invocation} from './eval_case.js';
import {
  EvalMetric,
  MatchType,
  ToolTrajectoryCriterionSchema,
} from './eval_metrics.js';
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';

/**
 * Options for constructing a {@link TrajectoryEvaluator}.
 *
 * Either `evalMetric` or a bare `threshold` may be supplied, but not both.
 */
export interface TrajectoryEvaluatorOptions {
  /** A bare threshold (implies an EXACT match). */
  threshold?: number;
  /** The metric whose criterion/threshold drives the evaluation. */
  evalMetric?: EvalMetric;
}

/**
 * Returns whether two tool calls are equal: same name and deeply-equal args.
 */
function areToolCallsEqual(
  actual: FunctionCall,
  expected: FunctionCall,
): boolean {
  return (
    actual.name === expected.name &&
    isDeepStrictEqual(actual.args, expected.args)
  );
}

function areToolCallsExactMatch(
  actualToolCalls: FunctionCall[],
  expectedToolCalls: FunctionCall[],
): boolean {
  if (actualToolCalls.length !== expectedToolCalls.length) {
    return false;
  }
  return actualToolCalls.every((actual, index) =>
    areToolCallsEqual(actual, expectedToolCalls[index]),
  );
}

function areToolCallsInOrderMatch(
  actualToolCalls: FunctionCall[],
  expectedToolCalls: FunctionCall[],
): boolean {
  if (expectedToolCalls.length === 0) {
    return true;
  }
  if (actualToolCalls.length === 0) {
    return false;
  }
  let expectedIndex = 0;
  for (const actual of actualToolCalls) {
    if (areToolCallsEqual(actual, expectedToolCalls[expectedIndex])) {
      expectedIndex++;
      if (expectedIndex === expectedToolCalls.length) {
        return true;
      }
    }
  }
  return false;
}

function areToolCallsAnyOrderMatch(
  actualToolCalls: FunctionCall[],
  expectedToolCalls: FunctionCall[],
): boolean {
  if (expectedToolCalls.length === 0) {
    return true;
  }
  if (actualToolCalls.length === 0) {
    return false;
  }
  // Each matched actual call is consumed once, so duplicate expected calls
  // require duplicate actual calls (multiset semantics).
  const remainingActual = [...actualToolCalls];
  for (const expected of expectedToolCalls) {
    const index = remainingActual.findIndex((actual) =>
      areToolCallsEqual(actual, expected),
    );
    if (index === -1) {
      return false;
    }
    remainingActual.splice(index, 1);
  }
  return true;
}

type ToolCallMatcher = (
  actualToolCalls: FunctionCall[],
  expectedToolCalls: FunctionCall[],
) => boolean;

const MATCHERS: Record<MatchType, ToolCallMatcher> = {
  [MatchType.EXACT]: areToolCallsExactMatch,
  [MatchType.IN_ORDER]: areToolCallsInOrderMatch,
  [MatchType.ANY_ORDER]: areToolCallsAnyOrderMatch,
};

/**
 * Evaluates tool use trajectories for accuracy.
 *
 * For each invocation, the sequence of tool calls produced by the agent is
 * compared with the expected tool calls using one of three match types. A
 * matching invocation scores 1.0, otherwise 0.0; the overall score is the
 * average across invocations.
 *
 *   - `EXACT`: perfect match, no extra or missing tool calls.
 *   - `IN_ORDER`: all expected tool calls present in the same relative order,
 *     with extra tool calls allowed in between.
 *   - `ANY_ORDER`: all expected tool calls present in any order, with extra
 *     tool calls allowed.
 */
export class TrajectoryEvaluator extends Evaluator {
  private readonly threshold?: number;
  private readonly matchType: MatchType;

  constructor({threshold, evalMetric}: TrajectoryEvaluatorOptions = {}) {
    super();
    if (threshold !== undefined && evalMetric !== undefined) {
      throw new Error(
        'Either eval_metric should be specified or threshold should be' +
          ' specified.',
      );
    }

    if (evalMetric !== undefined && evalMetric.criterion !== undefined) {
      const parsed = ToolTrajectoryCriterionSchema.safeParse(
        evalMetric.criterion,
      );
      if (!parsed.success) {
        throw new Error(
          `\`${evalMetric.metricName}\` metric expects a criterion of type` +
            ' `ToolTrajectoryCriterion`.',
        );
      }
      this.threshold = parsed.data.threshold;
      this.matchType = parsed.data.matchType;
    } else if (evalMetric !== undefined) {
      this.threshold = evalMetric.threshold;
      this.matchType = MatchType.EXACT;
    } else {
      this.threshold = threshold;
      this.matchType = MatchType.EXACT;
    }
  }

  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult {
    if (expectedInvocations === undefined) {
      throw new Error('expected_invocations is needed by this metric.');
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);
    void conversationScenario; // not supported for per-invocation evaluation.

    let totalToolUseAccuracy = 0.0;
    const perInvocationResults: PerInvocationResult[] = [];
    for (let i = 0; i < actualInvocations.length; i++) {
      const actual = actualInvocations[i];
      const expected = expectedInvocations[i];
      const toolUseAccuracy = this.calculateToolUseAccuracy(actual, expected);
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation: expected,
        score: toolUseAccuracy,
        evalStatus: this.getEvalStatus(toolUseAccuracy),
      });
      totalToolUseAccuracy += toolUseAccuracy;
    }

    if (perInvocationResults.length > 0) {
      const overallScore = totalToolUseAccuracy / perInvocationResults.length;
      return {
        overallScore,
        overallEvalStatus: this.getEvalStatus(overallScore),
        perInvocationResults,
      };
    }

    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    };
  }

  private calculateToolUseAccuracy(
    actualInvocation: Invocation,
    expectedInvocation: Invocation,
  ): number {
    const actualToolUses = getAllToolCalls(actualInvocation.intermediateData);
    const expectedToolUses = getAllToolCalls(
      expectedInvocation.intermediateData,
    );

    const matched = MATCHERS[this.matchType](actualToolUses, expectedToolUses);
    return matched ? 1.0 : 0.0;
  }

  private getEvalStatus(score: number): EvalStatus {
    return this.threshold !== undefined && score >= this.threshold
      ? EvalStatus.PASSED
      : EvalStatus.FAILED;
  }
}
