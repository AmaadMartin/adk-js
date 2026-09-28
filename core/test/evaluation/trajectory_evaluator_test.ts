/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  InputValidationError,
  ToolTrajectoryMatchType,
  TrajectoryEvaluator,
  type Invocation,
} from '@google/adk';
import type {Content, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  areToolCallsAnyOrderMatch,
  areToolCallsExactMatch,
  areToolCallsInOrderMatch,
} from '../../src/evaluation/trajectory_evaluator.js';

const USER_CONTENT: Content = {parts: [{text: 'User input here.'}]};

const T1: FunctionCall = {name: 't1', args: {}};
const T1_1: FunctionCall = {name: 't1_1', args: {}};
const T2: FunctionCall = {name: 't2', args: {}};
const T2_1: FunctionCall = {name: 't2_1', args: {}};
const T3: FunctionCall = {name: 't3', args: {}};
const T3_1: FunctionCall = {name: 't3_1', args: {}};
const T4: FunctionCall = {name: 't4', args: {}};

function invocation(...toolUses: FunctionCall[]): Invocation {
  return {userContent: USER_CONTENT, intermediateData: {toolUses}};
}

function recordedInvocation(...toolCalls: FunctionCall[]): Invocation {
  return {
    userContent: USER_CONTENT,
    intermediateData: {
      invocationEvents: toolCalls.map((functionCall) => ({
        author: 'agent',
        content: {parts: [{functionCall}]},
      })),
    },
  };
}

function evaluatorFor(matchType?: ToolTrajectoryMatchType) {
  return new TrajectoryEvaluator({threshold: 0.5, matchType});
}

describe('TrajectoryEvaluator with EXACT match', () => {
  it('scores equal tool calls', () => {
    const single = invocation({name: 'test_func', args: {arg1: 'val1'}});

    const result = evaluatorFor().evaluateInvocations([single], [single]);

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBe(1.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails different tool call names', () => {
    const actual = invocation({name: 'test_func1', args: {arg1: 'val1'}});
    const expected = invocation({name: 'test_func2', args: {arg1: 'val1'}});

    const result = evaluatorFor().evaluateInvocations([actual], [expected]);

    expect(result.overallScore).toBe(0.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults[0].score).toBe(0.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('fails different tool call args', () => {
    const actual = invocation({name: 'test_func', args: {arg1: 'val1'}});
    const expected = invocation({name: 'test_func', args: {arg1: 'val2'}});

    const result = evaluatorFor().evaluateInvocations([actual], [expected]);

    expect(result.overallScore).toBe(0.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('fails a different number of tool calls', () => {
    const call: FunctionCall = {name: 'test_func', args: {arg1: 'val1'}};

    const result = evaluatorFor().evaluateInvocations(
      [invocation(call)],
      [invocation(call, call)],
    );

    expect(result.overallScore).toBe(0.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('scores two invocations that made no tool call', () => {
    const empty: Invocation = {userContent: USER_CONTENT, intermediateData: {}};

    const result = evaluatorFor().evaluateInvocations([empty], [empty]);

    expect(result.overallScore).toBe(1.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('scores an invocation that carries no intermediate data', () => {
    const bare: Invocation = {userContent: USER_CONTENT};

    const result = evaluatorFor().evaluateInvocations([bare], [bare]);

    expect(result.overallScore).toBe(1.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('reads an omitted actual args as no arguments', () => {
    const actual = invocation({name: 'test_func'});
    const expected = invocation({name: 'test_func', args: {}});

    const result = evaluatorFor().evaluateInvocations([actual], [expected]);

    expect(result.overallScore).toBe(1.0);
  });

  it('reads an omitted expected args as no arguments', () => {
    const actual = invocation({name: 'test_func', args: {}});
    const expected = invocation({name: 'test_func'});

    const result = evaluatorFor().evaluateInvocations([actual], [expected]);

    expect(result.overallScore).toBe(1.0);
  });

  it('passes overall while one invocation fails', () => {
    const call1: FunctionCall = {name: 'test_func1', args: {arg1: 'val1'}};
    const call2: FunctionCall = {name: 'test_func2', args: {arg1: 'val1'}};

    const result = evaluatorFor().evaluateInvocations(
      [invocation(call1), invocation(call1)],
      [invocation(call1), invocation(call2)],
    );

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[1].score).toBe(0.0);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('pairs each result with the invocations it scored', () => {
    const actual = invocation(T1);
    const expected = invocation(T2);

    const result = evaluatorFor().evaluateInvocations([actual], [expected]);

    expect(result.perInvocationResults[0].actualInvocation).toBe(actual);
    expect(result.perInvocationResults[0].expectedInvocation).toBe(expected);
  });
});

describe('TrajectoryEvaluator with IN_ORDER match', () => {
  const evaluator = evaluatorFor(ToolTrajectoryMatchType.IN_ORDER);

  it('tolerates extra tool calls between the expected ones', () => {
    const result = evaluator.evaluateInvocations(
      [invocation(T1, T1_1, T2, T2_1, T3, T3_1)],
      [invocation(T1, T2, T3)],
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails a missing tool call', () => {
    const result = evaluator.evaluateInvocations(
      [invocation(T1, T1_1, T2, T2_1, T3_1)],
      [invocation(T1, T2, T4)],
    );

    expect(result.overallScore).toBe(0.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('fails the wrong order', () => {
    const result = evaluator.evaluateInvocations(
      [invocation(T1, T3, T2)],
      [invocation(T1, T2, T3)],
    );

    expect(result.overallScore).toBe(0.0);
  });

  it('defaults to EXACT when no match type is configured', () => {
    const result = evaluatorFor().evaluateInvocations(
      [invocation(T1, T1_1, T2, T2_1, T3, T3_1)],
      [invocation(T1, T2, T3)],
    );

    expect(result.overallScore).toBe(0.0);
  });
});

describe('TrajectoryEvaluator with ANY_ORDER match', () => {
  const evaluator = evaluatorFor(ToolTrajectoryMatchType.ANY_ORDER);

  it('tolerates extra tool calls in any order', () => {
    const result = evaluator.evaluateInvocations(
      [invocation(T2, T2_1, T1, T1_1, T3, T3_1)],
      [invocation(T1, T2, T3)],
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails a missing tool call', () => {
    const result = evaluator.evaluateInvocations(
      [invocation(T1, T1_1, T2, T2_1, T3_1)],
      [invocation(T1, T2, T4)],
    );

    expect(result.overallScore).toBe(0.0);
  });

  it('accepts a repeated expected call that occurred twice', () => {
    const result = evaluator.evaluateInvocations(
      [invocation(T1, T2, T3, T1)],
      [invocation(T1, T2, T1)],
    );

    expect(result.overallScore).toBe(1.0);
  });

  it('fails a repeated expected call that occurred once', () => {
    const result = evaluator.evaluateInvocations(
      [invocation(T1, T2, T3)],
      [invocation(T1, T2, T1)],
    );

    expect(result.overallScore).toBe(0.0);
  });

  it('leaves the caller trajectory untouched', () => {
    const toolUses = [T1, T2, T3];
    const actual: Invocation = {
      userContent: USER_CONTENT,
      intermediateData: {toolUses},
    };

    evaluator.evaluateInvocations([actual], [invocation(T2, T1)]);

    expect(toolUses).toEqual([T1, T2, T3]);
  });
});

describe('TrajectoryEvaluator with recorded events', () => {
  it('ignores the call id a run assigned', () => {
    const actual = recordedInvocation({
      id: 'toolu_01',
      name: 'execute_sql',
      args: {query: 'SELECT 1'},
    });
    const expected = recordedInvocation({
      name: 'execute_sql',
      args: {query: 'SELECT 1'},
    });

    const result = evaluatorFor().evaluateInvocations([actual], [expected]);

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails differing tool calls', () => {
    const actual = recordedInvocation({name: 'tool_a', args: {x: '1'}});
    const expected = recordedInvocation({name: 'tool_b', args: {x: '1'}});

    const result = evaluatorFor().evaluateInvocations([actual], [expected]);

    expect(result.overallScore).toBe(0.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('scores a three turn conversation and marks the turn that diverged', () => {
    const search: FunctionCall = {name: 'search_flights', args: {to: 'CDG'}};
    const price: FunctionCall = {name: 'check_price', args: {flight: 'AF83'}};
    const book: FunctionCall = {name: 'book', args: {flight: 'AF83'}};
    const strict = new TrajectoryEvaluator({
      threshold: 1.0,
      matchType: ToolTrajectoryMatchType.IN_ORDER,
    });

    const result = strict.evaluateInvocations(
      [
        recordedInvocation(search, search),
        recordedInvocation(price),
        recordedInvocation(),
      ],
      [
        recordedInvocation(search),
        recordedInvocation(price),
        recordedInvocation(book),
      ],
    );

    expect(result.overallScore).toBeCloseTo(2 / 3);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults.map((each) => each.evalStatus)).toEqual([
      EvalStatus.PASSED,
      EvalStatus.PASSED,
      EvalStatus.FAILED,
    ]);
  });
});

describe('TrajectoryEvaluator input handling', () => {
  it('evaluates nothing when there is no invocation', () => {
    const result = evaluatorFor().evaluateInvocations([], []);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('rejects absent expected invocations', () => {
    expect(() => evaluatorFor().evaluateInvocations([invocation(T1)])).toThrow(
      InputValidationError,
    );
    expect(() => evaluatorFor().evaluateInvocations([invocation(T1)])).toThrow(
      'expectedInvocations is needed by this metric.',
    );
  });

  it('rejects lists of different lengths, naming both', () => {
    expect(() =>
      evaluatorFor().evaluateInvocations(
        [invocation(T1), invocation(T2)],
        [invocation(T1), invocation(T2), invocation(T3)],
      ),
    ).toThrow(/same length; got 2 and 3\./);
  });

  it('rejects a match type outside the enum when constructed', () => {
    expect(() => evaluatorFor('SORT_OF' as ToolTrajectoryMatchType)).toThrow(
      InputValidationError,
    );
  });
});

describe('tool call matchers', () => {
  it('match anything when nothing is expected', () => {
    expect(areToolCallsExactMatch([], [])).toBe(true);
    expect(areToolCallsInOrderMatch([T1], [])).toBe(true);
    expect(areToolCallsAnyOrderMatch([T1], [])).toBe(true);
  });

  it('fail an expected call against an empty trajectory', () => {
    expect(areToolCallsExactMatch([], [T1])).toBe(false);
    expect(areToolCallsInOrderMatch([], [T1])).toBe(false);
    expect(areToolCallsAnyOrderMatch([], [T1])).toBe(false);
  });
});
