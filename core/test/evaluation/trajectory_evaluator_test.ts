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
  type ConversationScenario,
  type Invocation,
} from '@google/adk';
import type {Content, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';

const METRIC_NAME = 'tool_trajectory_avg_score';

const USER_CONTENT: Content = {parts: [{text: 'User input here.'}]};

function invocation(...toolUses: FunctionCall[]): Invocation {
  return {userContent: USER_CONTENT, intermediateData: {toolUses}};
}

/** An invocation whose intermediate data holds recorded events. */
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

function evaluatorFor(
  matchType: ToolTrajectoryMatchType,
  ignoreArgs = false,
): TrajectoryEvaluator {
  return new TrajectoryEvaluator({
    evalMetric: {
      metricName: METRIC_NAME,
      criterion: {threshold: 0.5, matchType, ignoreArgs},
    },
  });
}

const exactEvaluator = () => evaluatorFor(ToolTrajectoryMatchType.EXACT);

describe('TrajectoryEvaluator', () => {
  describe('construction', () => {
    it('names the criterion type it accepts', () => {
      expect(TrajectoryEvaluator.criterionType.name).toBe(
        'ToolTrajectoryCriterion',
      );
    });

    it('reads a match type spelled as a string in a criterion', () => {
      const evaluator = new TrajectoryEvaluator({
        evalMetric: {
          metricName: METRIC_NAME,
          threshold: 0.5,
          criterion: {threshold: 0.5, matchType: 'ANY_ORDER'},
        },
      });
      const first: FunctionCall = {name: 'test_func1', args: {}};
      const second: FunctionCall = {name: 'test_func2', args: {}};

      const result = evaluator.evaluateInvocations(
        [invocation(first, second)],
        [invocation(second, first)],
      );

      expect(result.overallScore).toBe(1.0);
    });

    it('scores against a plain threshold', () => {
      const result = new TrajectoryEvaluator({
        threshold: 0.5,
      }).evaluateInvocations(
        [invocation({name: 'ping', args: {}})],
        [invocation({name: 'ping', args: {}})],
      );

      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('falls back to the metric threshold and EXACT when there is no criterion', () => {
      const evaluator = new TrajectoryEvaluator({
        evalMetric: {metricName: METRIC_NAME, threshold: 0.5},
      });
      const first: FunctionCall = {name: 't1', args: {}};
      const second: FunctionCall = {name: 't2', args: {}};

      const result = evaluator.evaluateInvocations(
        [invocation(first, second)],
        [invocation(second, first)],
      );

      expect(result.overallScore).toBe(0.0);
    });

    it('rejects both a threshold and a metric', () => {
      expect(
        () =>
          new TrajectoryEvaluator({
            threshold: 0.5,
            evalMetric: {metricName: METRIC_NAME, threshold: 0.5},
          }),
      ).toThrow(
        new InputValidationError(
          'Either evalMetric should be specified or threshold should be' +
            ' specified.',
        ),
      );
    });

    it('rejects neither a threshold nor a metric', () => {
      expect(() => new TrajectoryEvaluator({})).toThrow(
        new InputValidationError(
          'A trajectory evaluation threshold is required.',
        ),
      );
    });

    it('rejects a metric that carries neither a criterion nor a threshold', () => {
      expect(
        () => new TrajectoryEvaluator({evalMetric: {metricName: METRIC_NAME}}),
      ).toThrow(
        new InputValidationError(
          `Evaluation metric '${METRIC_NAME}' requires a threshold.`,
        ),
      );
    });

    it('rejects a criterion whose threshold is not a number', () => {
      expect(
        () =>
          new TrajectoryEvaluator({
            evalMetric: {
              metricName: METRIC_NAME,
              criterion: {threshold: Number.NaN},
            },
          }),
      ).toThrow(
        new InputValidationError(
          `\`${METRIC_NAME}\` metric expects a criterion of type` +
            ' `ToolTrajectoryCriterion`. A tool trajectory criterion requires' +
            ' a numeric `threshold`.',
        ),
      );
    });

    it('rejects a criterion whose match type is unknown', () => {
      expect(
        () =>
          new TrajectoryEvaluator({
            evalMetric: {
              metricName: METRIC_NAME,
              criterion: {threshold: 0.5, matchType: 'random string'},
            },
          }),
      ).toThrow(
        new InputValidationError(
          `\`${METRIC_NAME}\` metric expects a criterion of type` +
            ' `ToolTrajectoryCriterion`. A tool trajectory criterion accepts' +
            ' as `matchType` one of EXACT, IN_ORDER, ANY_ORDER.',
        ),
      );
    });
  });

  describe('EXACT match', () => {
    it('scores equal tool calls 1.0', () => {
      const toolCall: FunctionCall = {name: 'test_func', args: {arg1: 'val1'}};

      const result = exactEvaluator().evaluateInvocations(
        [invocation(toolCall)],
        [invocation(toolCall)],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults).toHaveLength(1);
      expect(result.perInvocationResults[0].score).toBe(1.0);
      expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
    });

    it('scores different tool call names 0.0', () => {
      const result = exactEvaluator().evaluateInvocations(
        [invocation({name: 'test_func1', args: {arg1: 'val1'}})],
        [invocation({name: 'test_func2', args: {arg1: 'val1'}})],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
      expect(result.perInvocationResults[0].score).toBe(0.0);
      expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
    });

    it('scores different tool call arguments 0.0', () => {
      const result = exactEvaluator().evaluateInvocations(
        [invocation({name: 'test_func', args: {arg1: 'val1'}})],
        [invocation({name: 'test_func', args: {arg1: 'val2'}})],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('scores a different number of tool calls 0.0', () => {
      const toolCall: FunctionCall = {name: 'test_func', args: {arg1: 'val1'}};

      const result = exactEvaluator().evaluateInvocations(
        [invocation(toolCall)],
        [invocation(toolCall, toolCall)],
      );

      expect(result.overallScore).toBe(0.0);
    });

    it('scores two empty trajectories 1.0', () => {
      const result = exactEvaluator().evaluateInvocations(
        [invocation()],
        [invocation()],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('averages the scores of several invocations', () => {
      const first: FunctionCall = {name: 'test_func1', args: {arg1: 'val1'}};
      const second: FunctionCall = {name: 'test_func2', args: {arg1: 'val1'}};

      const result = exactEvaluator().evaluateInvocations(
        [invocation(first), invocation(first)],
        [invocation(first), invocation(second)],
      );

      expect(result.overallScore).toBe(0.5);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults).toHaveLength(2);
      expect(result.perInvocationResults[0].score).toBe(1.0);
      expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults[1].score).toBe(0.0);
      expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.FAILED);
    });
  });

  describe('IN_ORDER match', () => {
    const inOrderEvaluator = () =>
      evaluatorFor(ToolTrajectoryMatchType.IN_ORDER);
    const t1: FunctionCall = {name: 't1', args: {}};
    const t1_1: FunctionCall = {name: 't1_1', args: {}};
    const t2: FunctionCall = {name: 't2', args: {}};
    const t2_1: FunctionCall = {name: 't2_1', args: {}};
    const t3: FunctionCall = {name: 't3', args: {}};
    const t3_1: FunctionCall = {name: 't3_1', args: {}};
    const t4: FunctionCall = {name: 't4', args: {}};

    it('tolerates extra tool calls between the expected ones', () => {
      const result = inOrderEvaluator().evaluateInvocations(
        [invocation(t1, t1_1, t2, t2_1, t3, t3_1)],
        [invocation(t1, t2, t3)],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('scores a missing tool call 0.0', () => {
      const result = inOrderEvaluator().evaluateInvocations(
        [invocation(t1, t1_1, t2, t2_1, t3_1)],
        [invocation(t1, t2, t4)],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('scores tool calls in the wrong order 0.0', () => {
      const result = inOrderEvaluator().evaluateInvocations(
        [invocation(t1, t3, t2)],
        [invocation(t1, t2, t3)],
      );

      expect(result.overallScore).toBe(0.0);
    });

    it('scores an empty expected trajectory 1.0', () => {
      const result = inOrderEvaluator().evaluateInvocations(
        [invocation(t1)],
        [invocation()],
      );

      expect(result.overallScore).toBe(1.0);
    });
  });

  describe('ANY_ORDER match', () => {
    const anyOrderEvaluator = () =>
      evaluatorFor(ToolTrajectoryMatchType.ANY_ORDER);
    const t1: FunctionCall = {name: 't1', args: {}};
    const t1_1: FunctionCall = {name: 't1_1', args: {}};
    const t2: FunctionCall = {name: 't2', args: {}};
    const t2_1: FunctionCall = {name: 't2_1', args: {}};
    const t3: FunctionCall = {name: 't3', args: {}};
    const t3_1: FunctionCall = {name: 't3_1', args: {}};
    const t4: FunctionCall = {name: 't4', args: {}};

    it('tolerates extra tool calls in a different order', () => {
      const result = anyOrderEvaluator().evaluateInvocations(
        [invocation(t2, t2_1, t1, t1_1, t3, t3_1)],
        [invocation(t1, t2, t3)],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('scores a missing tool call 0.0', () => {
      const result = anyOrderEvaluator().evaluateInvocations(
        [invocation(t1, t1_1, t2, t2_1, t3_1)],
        [invocation(t1, t2, t4)],
      );

      expect(result.overallScore).toBe(0.0);
    });

    it('honours an expected tool call that repeats', () => {
      const result = anyOrderEvaluator().evaluateInvocations(
        [invocation(t1, t2, t3, t1)],
        [invocation(t1, t2, t1)],
      );

      expect(result.overallScore).toBe(1.0);
    });

    it('scores a repeat the actual trajectory lacks 0.0', () => {
      const result = anyOrderEvaluator().evaluateInvocations(
        [invocation(t1, t2, t3)],
        [invocation(t1, t2, t1)],
      );

      expect(result.overallScore).toBe(0.0);
    });

    it('leaves the trajectories it consumes untouched', () => {
      const actual = invocation(t2, t1);
      const expected = invocation(t1, t2);

      anyOrderEvaluator().evaluateInvocations([actual], [expected]);

      expect(actual).toEqual(invocation(t2, t1));
      expect(expected).toEqual(invocation(t1, t2));
    });
  });

  describe('recorded events', () => {
    it('ignores the call id a recorded trajectory carries', () => {
      const result = exactEvaluator().evaluateInvocations(
        [
          recordedInvocation({
            id: 'toolu_01',
            name: 'execute_sql',
            args: {query: 'SELECT 1'},
          }),
        ],
        [recordedInvocation({name: 'execute_sql', args: {query: 'SELECT 1'}})],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('scores differing recorded tool calls 0.0', () => {
      const result = exactEvaluator().evaluateInvocations(
        [recordedInvocation({name: 'tool_a', args: {x: '1'}})],
        [recordedInvocation({name: 'tool_b', args: {x: '1'}})],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });
  });

  describe('ignoreArgs', () => {
    const cases: Array<{
      name: string;
      matchType: ToolTrajectoryMatchType;
      actual: FunctionCall[];
      expected: FunctionCall[];
      score: number;
    }> = [
      {
        name: 'EXACT with different arguments passes',
        matchType: ToolTrajectoryMatchType.EXACT,
        actual: [
          {name: 't1', args: {a: 1}},
          {name: 't2', args: {b: 2}},
        ],
        expected: [
          {name: 't1', args: {x: 99}},
          {name: 't2', args: {y: 100}},
        ],
        score: 1.0,
      },
      {
        name: 'EXACT with different names fails',
        matchType: ToolTrajectoryMatchType.EXACT,
        actual: [{name: 't1', args: {}}],
        expected: [{name: 't2', args: {}}],
        score: 0.0,
      },
      {
        name: 'EXACT with a different tool count fails',
        matchType: ToolTrajectoryMatchType.EXACT,
        actual: [
          {name: 't1', args: {}},
          {name: 't2', args: {}},
        ],
        expected: [{name: 't1', args: {}}],
        score: 0.0,
      },
      {
        name: 'EXACT with empty trajectories passes',
        matchType: ToolTrajectoryMatchType.EXACT,
        actual: [],
        expected: [],
        score: 1.0,
      },
      {
        name: 'IN_ORDER with different arguments and extra tools passes',
        matchType: ToolTrajectoryMatchType.IN_ORDER,
        actual: [
          {name: 't1', args: {a: 1}},
          {name: 'extra', args: {}},
          {name: 't2', args: {b: 2}},
        ],
        expected: [
          {name: 't1', args: {x: 99}},
          {name: 't2', args: {y: 100}},
        ],
        score: 1.0,
      },
      {
        name: 'IN_ORDER in the wrong order fails',
        matchType: ToolTrajectoryMatchType.IN_ORDER,
        actual: [
          {name: 't2', args: {}},
          {name: 't1', args: {}},
        ],
        expected: [
          {name: 't1', args: {}},
          {name: 't2', args: {}},
        ],
        score: 0.0,
      },
      {
        name: 'IN_ORDER with a missing tool fails',
        matchType: ToolTrajectoryMatchType.IN_ORDER,
        actual: [{name: 't1', args: {}}],
        expected: [
          {name: 't1', args: {}},
          {name: 't2', args: {}},
        ],
        score: 0.0,
      },
      {
        name: 'ANY_ORDER with different arguments and swapped order passes',
        matchType: ToolTrajectoryMatchType.ANY_ORDER,
        actual: [
          {name: 't2', args: {b: 2}},
          {name: 't1', args: {a: 1}},
        ],
        expected: [
          {name: 't1', args: {x: 99}},
          {name: 't2', args: {y: 100}},
        ],
        score: 1.0,
      },
      {
        name: 'ANY_ORDER with a missing tool fails',
        matchType: ToolTrajectoryMatchType.ANY_ORDER,
        actual: [{name: 't1', args: {}}],
        expected: [
          {name: 't1', args: {}},
          {name: 't2', args: {}},
        ],
        score: 0.0,
      },
    ];

    it.each(cases)('compares names only: $name', (testCase) => {
      const result = evaluatorFor(testCase.matchType, true).evaluateInvocations(
        [invocation(...testCase.actual)],
        [invocation(...testCase.expected)],
      );

      expect(result.overallScore).toBe(testCase.score);
    });

    it('still compares arguments when it is false', () => {
      const result = evaluatorFor(
        ToolTrajectoryMatchType.EXACT,
        false,
      ).evaluateInvocations(
        [invocation({name: 't1', args: {a: 1}})],
        [invocation({name: 't1', args: {a: 2}})],
      );

      expect(result.overallScore).toBe(0.0);
    });

    it('applies to each invocation on its own', () => {
      const result = evaluatorFor(
        ToolTrajectoryMatchType.EXACT,
        true,
      ).evaluateInvocations(
        [
          invocation({name: 't1', args: {a: 1}}),
          invocation({name: 't1', args: {}}),
        ],
        [
          invocation({name: 't1', args: {z: 99}}),
          invocation({name: 't2', args: {}}),
        ],
      );

      expect(result.overallScore).toBe(0.5);
      expect(result.perInvocationResults[0].score).toBe(1.0);
      expect(result.perInvocationResults[1].score).toBe(0.0);
    });

    it('is read from a criterion written as a config object', () => {
      const evaluator = new TrajectoryEvaluator({
        evalMetric: {
          metricName: METRIC_NAME,
          criterion: {threshold: 0.5, matchType: 'EXACT', ignoreArgs: true},
        },
      });

      const result = evaluator.evaluateInvocations(
        [invocation({name: 't1', args: {a: 1}})],
        [invocation({name: 't1', args: {z: 999}})],
      );

      expect(result.overallScore).toBe(1.0);
    });
  });

  describe('conversationScenario', () => {
    it('scores the same whether a scenario is passed or omitted', () => {
      const scenario: ConversationScenario = {
        startingPrompt: 'I need to book a flight.',
        conversationPlan: 'Book a one-way flight, then rent a car.',
      };
      const actual = [invocation({name: 't1', args: {a: 1}})];
      const expected = [invocation({name: 't1', args: {a: 1}})];

      const withScenario = exactEvaluator().evaluateInvocations(
        actual,
        expected,
        scenario,
      );
      const withoutScenario = exactEvaluator().evaluateInvocations(
        actual,
        expected,
      );

      expect(withScenario).toEqual(withoutScenario);
    });
  });

  describe('argument normalization', () => {
    it('matches an actual call with no arguments against empty arguments', () => {
      const result = exactEvaluator().evaluateInvocations(
        [invocation({name: 'ping'})],
        [invocation({name: 'ping', args: {}})],
      );

      expect(result.overallScore).toBe(1.0);
    });

    it('matches an expected call with no arguments against empty arguments', () => {
      const result = exactEvaluator().evaluateInvocations(
        [invocation({name: 'ping', args: {}})],
        [invocation({name: 'ping'})],
      );

      expect(result.overallScore).toBe(1.0);
    });
  });

  describe('error paths', () => {
    it('evaluates nothing when there are no invocations', () => {
      const result = exactEvaluator().evaluateInvocations([], []);

      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
      expect(result.perInvocationResults).toEqual([]);
    });

    it('rejects an absent expected trajectory', () => {
      expect(() =>
        exactEvaluator().evaluateInvocations([invocation()]),
      ).toThrow(
        new InputValidationError(
          'expectedInvocations is needed by this metric.',
        ),
      );
    });

    it('rejects lists of different lengths, naming both', () => {
      expect(() =>
        exactEvaluator().evaluateInvocations(
          [invocation(), invocation()],
          [invocation()],
        ),
      ).toThrow(
        new InputValidationError(
          'actualInvocations and expectedInvocations must have the same' +
            ' length; got 2 and 1.',
        ),
      );
    });
  });
});
