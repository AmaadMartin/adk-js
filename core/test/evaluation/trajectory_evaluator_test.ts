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
  type BaseCriterion,
  type EvalMetric,
  type Invocation,
} from '@google/adk';
import type {Content, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {areToolCallsAnyOrderMatch} from '../../src/evaluation/trajectory_evaluator.js';

const USER_CONTENT: Content = {parts: [{text: 'User input here.'}]};
const METRIC_NAME = 'tool_trajectory_avg_score';
const THRESHOLD = 0.5;

/** Returns an invocation carrying a recorded tool call trajectory. */
function invocation(...toolUses: FunctionCall[]): Invocation {
  return {
    invocationId: '',
    userContent: USER_CONTENT,
    intermediateData: {toolUses, toolResponses: [], intermediateResponses: []},
    creationTimestamp: 0,
  };
}

/** Returns an invocation carrying one recorded event per tool call. */
function eventsInvocation(...toolCalls: FunctionCall[]): Invocation {
  return {
    invocationId: '',
    creationTimestamp: 0,
    userContent: USER_CONTENT,
    intermediateData: {
      invocationEvents: toolCalls.map((toolCall) => ({
        author: 'agent',
        content: {parts: [{functionCall: toolCall}]},
      })),
    },
  };
}

/** Returns an evaluator configured from a metric criterion. */
function evaluatorFor(matchType: string): TrajectoryEvaluator {
  return new TrajectoryEvaluator({
    evalMetric: {
      metricName: METRIC_NAME,
      criterion: {threshold: THRESHOLD, matchType},
    },
  });
}

const exactEvaluator = () => new TrajectoryEvaluator({threshold: THRESHOLD});

const t1: FunctionCall = {name: 't1', args: {}};
const t1_1: FunctionCall = {name: 't1_1', args: {}};
const t2: FunctionCall = {name: 't2', args: {}};
const t2_1: FunctionCall = {name: 't2_1', args: {}};
const t3: FunctionCall = {name: 't3', args: {}};
const t3_1: FunctionCall = {name: 't3_1', args: {}};
const t4: FunctionCall = {name: 't4', args: {}};

describe('TrajectoryEvaluator', () => {
  describe('construction', () => {
    it('reads the match type from a criterion string', () => {
      const result = evaluatorFor('in_order').evaluateInvocations(
        [invocation(t1, t1_1, t2)],
        [invocation(t1, t2)],
      );

      expect(result.overallScore).toBe(1.0);
    });

    it('reads an ANY_ORDER criterion from a metric', () => {
      const evalMetric: EvalMetric = {
        metricName: METRIC_NAME,
        threshold: THRESHOLD,
        criterion: {threshold: THRESHOLD, matchType: 'ANY_ORDER'},
      };
      const evaluator = new TrajectoryEvaluator({evalMetric});

      const result = evaluator.evaluateInvocations(
        [invocation(t1, t2)],
        [invocation(t2, t1)],
      );

      expect(result.overallScore).toBe(1.0);
    });

    it('reads the match type from an enum member', () => {
      const evaluator = new TrajectoryEvaluator({
        evalMetric: {
          metricName: METRIC_NAME,
          criterion: {
            threshold: THRESHOLD,
            matchType: ToolTrajectoryMatchType.ANY_ORDER,
          },
        },
      });

      const result = evaluator.evaluateInvocations(
        [invocation(t1, t2)],
        [invocation(t2, t1)],
      );

      expect(result.overallScore).toBe(1.0);
    });

    it('rejects both a threshold and a metric', () => {
      expect(
        () =>
          new TrajectoryEvaluator({
            threshold: THRESHOLD,
            evalMetric: {metricName: METRIC_NAME, threshold: THRESHOLD},
          }),
      ).toThrowError(
        new InputValidationError(
          'Either evalMetric should be specified or threshold should be' +
            ' specified.',
        ),
      );
    });

    it('rejects neither a threshold nor a metric', () => {
      expect(() => new TrajectoryEvaluator({})).toThrowError(
        new InputValidationError(
          'A trajectory evaluation threshold is required.',
        ),
      );
    });

    it('falls back to an EXACT match at the metric threshold', () => {
      const evaluator = new TrajectoryEvaluator({
        evalMetric: {metricName: METRIC_NAME, threshold: THRESHOLD},
      });

      const matched = evaluator.evaluateInvocations(
        [invocation(t1, t2)],
        [invocation(t1, t2)],
      );
      const reordered = evaluator.evaluateInvocations(
        [invocation(t1, t2)],
        [invocation(t2, t1)],
      );

      expect(matched.overallScore).toBe(1.0);
      expect(reordered.overallScore).toBe(0.0);
    });

    it('rejects a metric with neither a criterion nor a threshold', () => {
      expect(
        () => new TrajectoryEvaluator({evalMetric: {metricName: METRIC_NAME}}),
      ).toThrowError(
        new InputValidationError(
          `Evaluation metric '${METRIC_NAME}' requires a threshold.`,
        ),
      );
    });

    it('rejects a criterion whose threshold is not a finite number', () => {
      expect(
        () =>
          new TrajectoryEvaluator({
            evalMetric: {
              metricName: METRIC_NAME,
              criterion: {threshold: Number.NaN},
            },
          }),
      ).toThrowError(
        new InputValidationError(
          `\`${METRIC_NAME}\` metric expects a criterion of type` +
            ' `ToolTrajectoryCriterion`.',
        ),
      );
    });

    it('matches exactly when the criterion names no match type', () => {
      const evaluator = new TrajectoryEvaluator({
        evalMetric: {
          metricName: METRIC_NAME,
          criterion: {threshold: THRESHOLD},
        },
      });

      const result = evaluator.evaluateInvocations(
        [invocation(t1, t2)],
        [invocation(t2, t1)],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('reads a criterion parsed from an eval config file', () => {
      const criterion: BaseCriterion = JSON.parse(
        '{"threshold": 0.5, "matchType": "any order"}',
      );
      const evaluator = new TrajectoryEvaluator({
        evalMetric: {metricName: METRIC_NAME, criterion},
      });

      const result = evaluator.evaluateInvocations(
        [invocation(t1, t2)],
        [invocation(t2, t1)],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('rejects a parsed criterion that carries no threshold', () => {
      const criterion: BaseCriterion = JSON.parse('{"matchType": "exact"}');

      expect(
        () =>
          new TrajectoryEvaluator({
            evalMetric: {metricName: METRIC_NAME, criterion},
          }),
      ).toThrowError(InputValidationError);
    });

    it('rejects a criterion whose match type is unknown', () => {
      expect(() => evaluatorFor('random string')).toThrowError(
        new InputValidationError(
          `\`${METRIC_NAME}\` metric expects a criterion of type` +
            ' `ToolTrajectoryCriterion`.',
        ),
      );
    });
  });

  describe('EXACT match', () => {
    it('scores identical tool calls 1.0', () => {
      const toolCall: FunctionCall = {name: 'test_func', args: {arg1: 'val1'}};
      const actual = invocation(toolCall);

      const result = exactEvaluator().evaluateInvocations([actual], [actual]);

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults).toHaveLength(1);
      expect(result.perInvocationResults[0].score).toBe(1.0);
      expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults[0].actualInvocation).toBe(actual);
      expect(result.perInvocationResults[0].expectedInvocation).toBe(actual);
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
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('scores two empty trajectories 1.0', () => {
      const empty: Invocation = invocation();

      const result = exactEvaluator().evaluateInvocations([empty], [empty]);

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('averages the invocation scores and passes at the threshold', () => {
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
    it('tolerates extra tool calls between the expected ones', () => {
      const result = evaluatorFor('IN_ORDER').evaluateInvocations(
        [invocation(t1, t1_1, t2, t2_1, t3, t3_1)],
        [invocation(t1, t2, t3)],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('fails when an expected tool call is missing', () => {
      const result = evaluatorFor('IN_ORDER').evaluateInvocations(
        [invocation(t1, t1_1, t2, t2_1, t3_1)],
        [invocation(t1, t2, t4)],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('fails when the expected tool calls are out of order', () => {
      const result = evaluatorFor('IN_ORDER').evaluateInvocations(
        [invocation(t1, t3, t2)],
        [invocation(t1, t2, t3)],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });
  });

  describe('ANY_ORDER match', () => {
    it('tolerates extra tool calls in a different order', () => {
      const result = evaluatorFor('ANY_ORDER').evaluateInvocations(
        [invocation(t2, t2_1, t1, t1_1, t3, t3_1)],
        [invocation(t1, t2, t3)],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('fails when an expected tool call is missing', () => {
      const result = evaluatorFor('ANY_ORDER').evaluateInvocations(
        [invocation(t1, t1_1, t2, t2_1, t3_1)],
        [invocation(t1, t2, t4)],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('honours a repeated expected tool call', () => {
      const result = evaluatorFor('ANY_ORDER').evaluateInvocations(
        [invocation(t1, t2, t3, t1)],
        [invocation(t1, t2, t1)],
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('fails when a repeated expected tool call happened once', () => {
      const result = evaluatorFor('ANY_ORDER').evaluateInvocations(
        [invocation(t1, t2, t3)],
        [invocation(t1, t2, t1)],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('does not mutate the trajectories it compares', () => {
      const actual = [t1, t2, t3];
      const expected = [t2, t1];

      expect(areToolCallsAnyOrderMatch(actual, expected)).toBe(true);
      expect(actual).toEqual([t1, t2, t3]);
      expect(expected).toEqual([t2, t1]);
    });
  });

  describe('recorded events', () => {
    it('scores identical calls 1.0 and ignores the call id', () => {
      const actual = eventsInvocation({
        id: 'toolu_01',
        name: 'execute_sql',
        args: {query: 'SELECT 1'},
      });
      const expected = eventsInvocation({
        name: 'execute_sql',
        args: {query: 'SELECT 1'},
      });

      const result = exactEvaluator().evaluateInvocations([actual], [expected]);

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('scores different tool names 0.0', () => {
      const result = exactEvaluator().evaluateInvocations(
        [eventsInvocation({name: 'tool_a', args: {x: '1'}})],
        [eventsInvocation({name: 'tool_b', args: {x: '1'}})],
      );

      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
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

    it('rejects absent expected invocations', () => {
      expect(() =>
        exactEvaluator().evaluateInvocations([invocation(t1)]),
      ).toThrowError(
        new InputValidationError(
          'expectedInvocations is needed by this metric.',
        ),
      );
    });

    it('rejects lists of different lengths, naming both lengths', () => {
      expect(() =>
        exactEvaluator().evaluateInvocations([invocation(t1)], []),
      ).toThrowError(
        new InputValidationError(
          'actualInvocations and expectedInvocations must have the same length; ' +
            'got 1 and 0.',
        ),
      );
    });
  });
});
