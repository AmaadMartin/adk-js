/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  InputValidationError,
  Invocation,
  ToolTrajectoryMatchType,
  TrajectoryEvaluator,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
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
    toolUses,
  };
}

/** Scores one pair of trajectories and returns the overall score. */
async function scoreOnce(
  matchType: ToolTrajectoryMatchType,
  actual: FunctionCall[],
  expected: FunctionCall[],
): Promise<number | undefined> {
  const evaluator = new TrajectoryEvaluator({threshold: 0.5, matchType});
  const result = await evaluator.evaluateInvocations(
    [invocation(actual)],
    [invocation(expected)],
  );

  return result.overallScore;
}

describe('TrajectoryEvaluator with EXACT match', () => {
  const evaluator = new TrajectoryEvaluator({
    threshold: 0.5,
    matchType: ToolTrajectoryMatchType.EXACT,
  });

  it('scores an identical trajectory 1.0 and passes', async () => {
    const result = await evaluator.evaluateInvocations(
      [invocation([T1])],
      [invocation([T1])],
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBe(1.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('echoes both invocations back in the per-invocation result', async () => {
    const actual = invocation([T1]);
    const expected = invocation([T1]);

    const result = await evaluator.evaluateInvocations([actual], [expected]);

    expect(result.perInvocationResults[0].actualInvocation).toBe(actual);
    expect(result.perInvocationResults[0].expectedInvocation).toBe(expected);
  });

  it('scores a different tool name 0.0', async () => {
    const result = await evaluator.evaluateInvocations(
      [invocation([T1])],
      [invocation([T2])],
    );

    expect(result.overallScore).toBe(0.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('scores the same tool with different args 0.0', async () => {
    const result = await evaluator.evaluateInvocations(
      [invocation([{name: 'tool_1', args: {a: 1}}])],
      [invocation([{name: 'tool_1', args: {a: 2}}])],
    );

    expect(result.overallScore).toBe(0.0);
  });

  it('scores a different number of tool calls 0.0', async () => {
    const result = await evaluator.evaluateInvocations(
      [invocation([T1, T2])],
      [invocation([T1])],
    );

    expect(result.overallScore).toBe(0.0);
  });

  it('scores two empty trajectories 1.0', async () => {
    const result = await evaluator.evaluateInvocations(
      [invocation([])],
      [invocation([])],
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('treats a missing toolUses as no tool calls', async () => {
    const withoutToolUses: Invocation = {
      userContent: {role: 'user', parts: [{text: 'do the thing'}]},
    };

    const result = await evaluator.evaluateInvocations(
      [withoutToolUses],
      [withoutToolUses],
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('averages over invocations and passes at exactly the threshold', async () => {
    const result = await evaluator.evaluateInvocations(
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

  it('ignores the tool call id', async () => {
    const result = await evaluator.evaluateInvocations(
      [
        invocation([
          {id: 'toolu_01', name: 'execute_sql', args: {query: 'SELECT 1'}},
        ]),
      ],
      [invocation([{name: 'execute_sql', args: {query: 'SELECT 1'}}])],
    );

    expect(result.overallScore).toBe(1.0);
  });

  it('treats missing args on the actual call as empty args', async () => {
    const result = await evaluator.evaluateInvocations(
      [invocation([{name: 'no_args_tool'}])],
      [invocation([{name: 'no_args_tool', args: {}}])],
    );

    expect(result.overallScore).toBe(1.0);
  });

  it('treats missing args on the expected call as empty args', async () => {
    const result = await evaluator.evaluateInvocations(
      [invocation([{name: 'no_args_tool', args: {}}])],
      [invocation([{name: 'no_args_tool'}])],
    );

    expect(result.overallScore).toBe(1.0);
  });

  it('defaults to EXACT when matchType is omitted', async () => {
    const defaulted = new TrajectoryEvaluator({threshold: 0.5});

    const result = await defaulted.evaluateInvocations(
      [invocation([T1, T2])],
      [invocation([T1])],
    );

    expect(result.overallScore).toBe(0.0);
  });
});

describe('TrajectoryEvaluator with IN_ORDER match', () => {
  const inOrder = ToolTrajectoryMatchType.IN_ORDER;

  it('accepts extra calls between the expected ones', async () => {
    await expect(
      scoreOnce(inOrder, [T1, T1_1, T2, T2_1, T3, T3_1], [T1, T2, T3]),
    ).resolves.toBe(1.0);
  });

  it('rejects a missing expected call', async () => {
    await expect(
      scoreOnce(inOrder, [T1, T1_1, T2, T2_1, T3_1], [T1, T2, T4]),
    ).resolves.toBe(0.0);
  });

  it('rejects expected calls that arrive out of order', async () => {
    await expect(scoreOnce(inOrder, [T1, T3, T2], [T1, T2, T3])).resolves.toBe(
      0.0,
    );
  });

  it('accepts an empty expected trajectory', async () => {
    await expect(scoreOnce(inOrder, [T1], [])).resolves.toBe(1.0);
  });

  it('rejects an empty actual trajectory', async () => {
    await expect(scoreOnce(inOrder, [], [T1])).resolves.toBe(0.0);
  });
});

describe('TrajectoryEvaluator with ANY_ORDER match', () => {
  const anyOrder = ToolTrajectoryMatchType.ANY_ORDER;

  it('accepts the expected calls in any order', async () => {
    await expect(
      scoreOnce(anyOrder, [T2, T2_1, T1, T1_1, T3, T3_1], [T1, T2, T3]),
    ).resolves.toBe(1.0);
  });

  it('rejects a missing expected call', async () => {
    await expect(
      scoreOnce(anyOrder, [T1, T1_1, T2, T2_1, T3_1], [T1, T2, T4]),
    ).resolves.toBe(0.0);
  });

  it('accepts a repeated expected call when the actual list repeats it', async () => {
    await expect(
      scoreOnce(anyOrder, [T1, T2, T3, T1], [T1, T2, T1]),
    ).resolves.toBe(1.0);
  });

  it('rejects a repeated expected call the actual list holds only once', async () => {
    await expect(scoreOnce(anyOrder, [T1, T2, T3], [T1, T2, T1])).resolves.toBe(
      0.0,
    );
  });

  it('accepts an empty expected trajectory', async () => {
    await expect(scoreOnce(anyOrder, [T1], [])).resolves.toBe(1.0);
  });

  it('rejects an empty actual trajectory', async () => {
    await expect(scoreOnce(anyOrder, [], [T1])).resolves.toBe(0.0);
  });

  it('does not mutate the trajectories it is given', async () => {
    const actual = invocation([T1, T2, T3, T1]);
    const expected = invocation([T1, T2, T1]);
    const evaluator = new TrajectoryEvaluator({
      threshold: 0.5,
      matchType: anyOrder,
    });

    await evaluator.evaluateInvocations([actual], [expected]);

    expect(actual.toolUses).toEqual([T1, T2, T3, T1]);
    expect(expected.toolUses).toEqual([T1, T2, T1]);
  });
});

describe('TrajectoryEvaluator input handling', () => {
  const evaluator = new TrajectoryEvaluator({threshold: 0.5});

  it('reports NOT_EVALUATED when there is nothing to score', async () => {
    const result = await evaluator.evaluateInvocations([], []);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('rejects a call without expected invocations', async () => {
    await expect(
      evaluator.evaluateInvocations([invocation([T1])]),
    ).rejects.toThrow(InputValidationError);
    await expect(
      evaluator.evaluateInvocations([invocation([T1])]),
    ).rejects.toThrow('expectedInvocations is needed by this metric.');
  });

  it('rejects invocation lists of different lengths', async () => {
    await expect(
      evaluator.evaluateInvocations(
        [invocation([T1]), invocation([T2])],
        [invocation([T1])],
      ),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length; got 2 and 1.',
    );
  });
});
