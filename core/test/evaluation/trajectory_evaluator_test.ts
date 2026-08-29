/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Invocation} from '@google/adk';
import {
  EvalStatus,
  InputValidationError,
  parseToolTrajectoryMatchType,
  ToolTrajectoryMatchType,
  TrajectoryEvaluator,
} from '@google/adk';
import type {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';

const T1: FunctionCall = {name: 'tool_1', args: {a: 1}};
const T1_1: FunctionCall = {name: 'tool_1_1', args: {a: 11}};
const T2: FunctionCall = {name: 'tool_2', args: {b: 2}};
const T2_1: FunctionCall = {name: 'tool_2_1', args: {b: 21}};
const T3: FunctionCall = {name: 'tool_3', args: {c: 3}};
const T3_1: FunctionCall = {name: 'tool_3_1', args: {c: 31}};
const T4: FunctionCall = {name: 'tool_4', args: {d: 4}};

/** An invocation carrying the given tool calls, with a fixed user turn. */
function invocation(toolUses: FunctionCall[]): Invocation {
  return {
    userContent: {role: 'user', parts: [{text: 'do the thing'}]},
    intermediateData: {toolUses},
  };
}

/** The tool calls an invocation carries, read back through the union type. */
function toolUsesOf(invocation: Invocation): FunctionCall[] | undefined {
  const intermediateData = invocation.intermediateData;
  if (
    intermediateData === undefined ||
    'invocationEvents' in intermediateData
  ) {
    return undefined;
  }

  return intermediateData.toolUses;
}

/** Scores one pair of trajectories and returns the overall score. */
function scoreOnce(
  matchType: ToolTrajectoryMatchType,
  actual: FunctionCall[],
  expected: FunctionCall[],
): number | undefined {
  const evaluator = new TrajectoryEvaluator({threshold: 0.5, matchType});
  return evaluator.evaluateInvocations(
    [invocation(actual)],
    [invocation(expected)],
  ).overallScore;
}

describe('parseToolTrajectoryMatchType', () => {
  it.each([
    ['exact', ToolTrajectoryMatchType.EXACT],
    ['EXACT', ToolTrajectoryMatchType.EXACT],
    ['  exact  ', ToolTrajectoryMatchType.EXACT],
    ['in order', ToolTrajectoryMatchType.IN_ORDER],
    ['IN ORDER', ToolTrajectoryMatchType.IN_ORDER],
    ['In OrDeR', ToolTrajectoryMatchType.IN_ORDER],
    ['in-order', ToolTrajectoryMatchType.IN_ORDER],
    ['IN-ORDER', ToolTrajectoryMatchType.IN_ORDER],
    ['in_order', ToolTrajectoryMatchType.IN_ORDER],
    ['any order', ToolTrajectoryMatchType.ANY_ORDER],
    ['ANY ORDER', ToolTrajectoryMatchType.ANY_ORDER],
    ['any-order', ToolTrajectoryMatchType.ANY_ORDER],
    ['ANY-ORDER', ToolTrajectoryMatchType.ANY_ORDER],
    ['any_order', ToolTrajectoryMatchType.ANY_ORDER],
  ])('resolves %s', (value, expected) => {
    expect(parseToolTrajectoryMatchType(value)).toBe(expected);
  });

  it('rejects a string that names no match type', () => {
    expect(() => parseToolTrajectoryMatchType('random string')).toThrow(
      InputValidationError,
    );
    expect(() => parseToolTrajectoryMatchType('random string')).toThrow(
      'Unknown tool trajectory match type: random string.',
    );
  });
});

describe('TrajectoryEvaluator with EXACT match', () => {
  const evaluator = new TrajectoryEvaluator({
    threshold: 0.5,
    matchType: ToolTrajectoryMatchType.EXACT,
  });

  it('scores an identical trajectory 1.0 and passes', () => {
    const result = evaluator.evaluateInvocations(
      [invocation([T1])],
      [invocation([T1])],
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBe(1.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('echoes both invocations back in the per-invocation result', () => {
    const actual = invocation([T1]);
    const expected = invocation([T1]);

    const result = evaluator.evaluateInvocations([actual], [expected]);

    expect(result.perInvocationResults[0].actualInvocation).toBe(actual);
    expect(result.perInvocationResults[0].expectedInvocation).toBe(expected);
  });

  it('scores a different tool name 0.0', () => {
    const result = evaluator.evaluateInvocations(
      [invocation([T1])],
      [invocation([T2])],
    );

    expect(result.overallScore).toBe(0.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('scores the same tool with different args 0.0', () => {
    const result = evaluator.evaluateInvocations(
      [invocation([{name: 'tool_1', args: {a: 1}}])],
      [invocation([{name: 'tool_1', args: {a: 2}}])],
    );

    expect(result.overallScore).toBe(0.0);
  });

  it('scores a different number of tool calls 0.0', () => {
    const result = evaluator.evaluateInvocations(
      [invocation([T1, T2])],
      [invocation([T1])],
    );

    expect(result.overallScore).toBe(0.0);
  });

  it('scores two empty trajectories 1.0', () => {
    const result = evaluator.evaluateInvocations(
      [invocation([])],
      [invocation([])],
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('treats a missing intermediateData as no tool calls', () => {
    const withoutIntermediateData: Invocation = {
      userContent: {role: 'user', parts: [{text: 'do the thing'}]},
    };

    const result = evaluator.evaluateInvocations(
      [withoutIntermediateData],
      [withoutIntermediateData],
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('averages over invocations and passes at exactly the threshold', () => {
    const result = evaluator.evaluateInvocations(
      [invocation([T1]), invocation([T1])],
      [invocation([T1]), invocation([T2])],
    );

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults.map((r) => r.score)).toEqual([1.0, 0.0]);
    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.PASSED,
      EvalStatus.FAILED,
    ]);
  });

  it('ignores the tool call id', () => {
    const result = evaluator.evaluateInvocations(
      [
        invocation([
          {id: 'toolu_01', name: 'execute_sql', args: {query: 'SELECT 1'}},
        ]),
      ],
      [invocation([{name: 'execute_sql', args: {query: 'SELECT 1'}}])],
    );

    expect(result.overallScore).toBe(1.0);
  });

  it('treats missing args on the actual call as empty args', () => {
    const result = evaluator.evaluateInvocations(
      [invocation([{name: 'no_args_tool'}])],
      [invocation([{name: 'no_args_tool', args: {}}])],
    );

    expect(result.overallScore).toBe(1.0);
  });

  it('treats missing args on the expected call as empty args', () => {
    const result = evaluator.evaluateInvocations(
      [invocation([{name: 'no_args_tool', args: {}}])],
      [invocation([{name: 'no_args_tool'}])],
    );

    expect(result.overallScore).toBe(1.0);
  });

  it('defaults to EXACT when matchType is omitted', () => {
    const defaulted = new TrajectoryEvaluator({threshold: 0.5});

    const result = defaulted.evaluateInvocations(
      [invocation([T1, T2])],
      [invocation([T1])],
    );

    expect(result.overallScore).toBe(0.0);
  });
});

describe('TrajectoryEvaluator with IN_ORDER match', () => {
  const inOrder = ToolTrajectoryMatchType.IN_ORDER;

  it('accepts extra calls between the expected ones', () => {
    expect(
      scoreOnce(inOrder, [T1, T1_1, T2, T2_1, T3, T3_1], [T1, T2, T3]),
    ).toBe(1.0);
  });

  it('rejects a missing expected call', () => {
    expect(scoreOnce(inOrder, [T1, T1_1, T2, T2_1, T3_1], [T1, T2, T4])).toBe(
      0.0,
    );
  });

  it('rejects expected calls that arrive out of order', () => {
    expect(scoreOnce(inOrder, [T1, T3, T2], [T1, T2, T3])).toBe(0.0);
  });

  it('accepts an empty expected trajectory', () => {
    expect(scoreOnce(inOrder, [T1], [])).toBe(1.0);
  });

  it('rejects an empty actual trajectory', () => {
    expect(scoreOnce(inOrder, [], [T1])).toBe(0.0);
  });
});

describe('TrajectoryEvaluator with ANY_ORDER match', () => {
  const anyOrder = ToolTrajectoryMatchType.ANY_ORDER;

  it('accepts the expected calls in any order', () => {
    expect(
      scoreOnce(anyOrder, [T2, T2_1, T1, T1_1, T3, T3_1], [T1, T2, T3]),
    ).toBe(1.0);
  });

  it('rejects a missing expected call', () => {
    expect(scoreOnce(anyOrder, [T1, T1_1, T2, T2_1, T3_1], [T1, T2, T4])).toBe(
      0.0,
    );
  });

  it('accepts a repeated expected call when the actual list repeats it', () => {
    expect(scoreOnce(anyOrder, [T1, T2, T3, T1], [T1, T2, T1])).toBe(1.0);
  });

  it('rejects a repeated expected call the actual list holds only once', () => {
    expect(scoreOnce(anyOrder, [T1, T2, T3], [T1, T2, T1])).toBe(0.0);
  });

  it('accepts an empty expected trajectory', () => {
    expect(scoreOnce(anyOrder, [T1], [])).toBe(1.0);
  });

  it('rejects an empty actual trajectory', () => {
    expect(scoreOnce(anyOrder, [], [T1])).toBe(0.0);
  });

  it('does not mutate the trajectories it is given', () => {
    const actual = invocation([T1, T2, T3, T1]);
    const expected = invocation([T1, T2, T1]);
    const evaluator = new TrajectoryEvaluator({
      threshold: 0.5,
      matchType: anyOrder,
    });

    evaluator.evaluateInvocations([actual], [expected]);

    expect(toolUsesOf(actual)).toEqual([T1, T2, T3, T1]);
    expect(toolUsesOf(expected)).toEqual([T1, T2, T1]);
  });
});

describe('TrajectoryEvaluator input handling', () => {
  const evaluator = new TrajectoryEvaluator({threshold: 0.5});

  it('reports NOT_EVALUATED when there is nothing to score', () => {
    const result = evaluator.evaluateInvocations([], []);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('rejects a call without expected invocations', () => {
    expect(() => evaluator.evaluateInvocations([invocation([T1])])).toThrow(
      InputValidationError,
    );
    expect(() => evaluator.evaluateInvocations([invocation([T1])])).toThrow(
      'expectedInvocations is needed by this metric.',
    );
  });

  it('rejects invocation lists of different lengths', () => {
    expect(() =>
      evaluator.evaluateInvocations(
        [invocation([T1]), invocation([T2])],
        [invocation([T1])],
      ),
    ).toThrow(
      'actualInvocations and expectedInvocations must have the same length; got 2 and 1.',
    );
  });
});
