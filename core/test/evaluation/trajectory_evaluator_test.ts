/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type EvalMetric,
  EvalStatus,
  type Invocation,
  InvocationSchema,
  MatchType,
  PrebuiltMetrics,
  ToolTrajectoryCriterionSchema,
  TrajectoryEvaluator,
} from '@google/adk';
import {Content, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';

const USER_CONTENT: Content = {
  parts: [{text: 'User input here.'}],
};

function toolUsesInvocation(toolUses: FunctionCall[]): Invocation {
  return InvocationSchema.parse({
    userContent: USER_CONTENT,
    intermediateData: {toolUses},
  });
}

function invocationEventsInvocation(...toolCalls: FunctionCall[]): Invocation {
  return InvocationSchema.parse({
    userContent: USER_CONTENT,
    intermediateData: {
      invocationEvents: toolCalls.map((tc) => ({
        author: 'agent',
        content: {parts: [{functionCall: tc}]},
      })),
    },
  });
}

function trajectoryEvalMetric(matchType: MatchType): EvalMetric {
  return {
    metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
    threshold: 0.5,
    criterion: ToolTrajectoryCriterionSchema.parse({threshold: 0.5, matchType}),
  };
}

function exactEvaluator(): TrajectoryEvaluator {
  return new TrajectoryEvaluator({
    evalMetric: trajectoryEvalMetric(MatchType.EXACT),
  });
}

function inOrderEvaluator(): TrajectoryEvaluator {
  return new TrajectoryEvaluator({
    evalMetric: trajectoryEvalMetric(MatchType.IN_ORDER),
  });
}

function anyOrderEvaluator(): TrajectoryEvaluator {
  return new TrajectoryEvaluator({
    evalMetric: trajectoryEvalMetric(MatchType.ANY_ORDER),
  });
}

describe('evaluation/trajectory_evaluator', () => {
  describe('ToolTrajectoryCriterion match type coercion', () => {
    it('accepts a string match type', () => {
      const criterion = ToolTrajectoryCriterionSchema.parse({
        threshold: 0.5,
        matchType: 'in_order',
      });
      expect(criterion.matchType).toBe(MatchType.IN_ORDER);
    });

    it.each([
      ['exact', MatchType.EXACT],
      ['EXACT', MatchType.EXACT],
      [' exact ', MatchType.EXACT],
      ['in order', MatchType.IN_ORDER],
      ['IN ORDER', MatchType.IN_ORDER],
      ['In OrDeR', MatchType.IN_ORDER],
      ['in-order', MatchType.IN_ORDER],
      ['IN-ORDER', MatchType.IN_ORDER],
      ['in_order', MatchType.IN_ORDER],
      ['any order', MatchType.ANY_ORDER],
      ['ANY ORDER', MatchType.ANY_ORDER],
      ['any-order', MatchType.ANY_ORDER],
      ['ANY-ORDER', MatchType.ANY_ORDER],
      ['any_order', MatchType.ANY_ORDER],
    ])('normalizes match type %s', (matchType, expected) => {
      const criterion = ToolTrajectoryCriterionSchema.parse({
        threshold: 0.5,
        matchType,
      });
      expect(criterion.matchType).toBe(expected);
    });

    it('rejects an unknown string match type', () => {
      expect(() =>
        ToolTrajectoryCriterionSchema.parse({
          threshold: 0.5,
          matchType: 'random string',
        }),
      ).toThrow();
    });
  });

  describe('constructor', () => {
    it('accepts a string match type from an eval metric criterion dict', () => {
      const evalMetric: EvalMetric = {
        metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
        threshold: 0.5,
        criterion: {threshold: 0.5, matchType: 'ANY_ORDER'} as never,
      };
      const evaluator = new TrajectoryEvaluator({evalMetric});
      const toolCall1: FunctionCall = {name: 'test_func1', args: {}};
      const toolCall2: FunctionCall = {name: 'test_func2', args: {}};
      const result = evaluator.evaluateInvocations(
        [toolUsesInvocation([toolCall1, toolCall2])],
        [toolUsesInvocation([toolCall2, toolCall1])],
      );
      expect(result.overallScore).toBe(1.0);
    });

    it('throws when both threshold and evalMetric are specified', () => {
      expect(
        () =>
          new TrajectoryEvaluator({
            threshold: 0.5,
            evalMetric: trajectoryEvalMetric(MatchType.EXACT),
          }),
      ).toThrow(
        'Either eval_metric should be specified or threshold should be specified.',
      );
    });

    it('throws when the criterion is not a ToolTrajectoryCriterion', () => {
      const evalMetric: EvalMetric = {
        metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
        threshold: 0.5,
        criterion: {threshold: 0.5, matchType: 'random string'} as never,
      };
      expect(() => new TrajectoryEvaluator({evalMetric})).toThrow(
        '`tool_trajectory_avg_score` metric expects a criterion of type' +
          ' `ToolTrajectoryCriterion`.',
      );
    });

    it('falls back to evalMetric threshold and EXACT when no criterion', () => {
      const evalMetric: EvalMetric = {
        metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
        threshold: 0.5,
      };
      const evaluator = new TrajectoryEvaluator({evalMetric});
      const toolCall: FunctionCall = {name: 'test_func', args: {arg1: 'val1'}};
      const result = evaluator.evaluateInvocations(
        [toolUsesInvocation([toolCall])],
        [toolUsesInvocation([toolCall])],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('supports a bare threshold with EXACT match', () => {
      const evaluator = new TrajectoryEvaluator({threshold: 1.0});
      const toolCall: FunctionCall = {name: 'test_func', args: {arg1: 'val1'}};
      const result = evaluator.evaluateInvocations(
        [toolUsesInvocation([toolCall])],
        [toolUsesInvocation([toolCall])],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });
  });

  describe('EXACT match', () => {
    it('scores 1.0 for equal tool calls', () => {
      const toolCall: FunctionCall = {name: 'test_func', args: {arg1: 'val1'}};
      const invocation = toolUsesInvocation([toolCall]);
      const result = exactEvaluator().evaluateInvocations(
        [invocation],
        [invocation],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults).toHaveLength(1);
      expect(result.perInvocationResults[0].score).toBe(1.0);
      expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
    });

    it('scores 0.0 for different tool call names', () => {
      const result = exactEvaluator().evaluateInvocations(
        [toolUsesInvocation([{name: 'test_func1', args: {arg1: 'val1'}}])],
        [toolUsesInvocation([{name: 'test_func2', args: {arg1: 'val1'}}])],
      );
      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
      expect(result.perInvocationResults[0].score).toBe(0.0);
      expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
    });

    it('scores 0.0 for different tool call args', () => {
      const result = exactEvaluator().evaluateInvocations(
        [toolUsesInvocation([{name: 'test_func', args: {arg1: 'val1'}}])],
        [toolUsesInvocation([{name: 'test_func', args: {arg1: 'val2'}}])],
      );
      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('scores 0.0 for a different number of tool calls', () => {
      const toolCall: FunctionCall = {name: 'test_func', args: {arg1: 'val1'}};
      const result = exactEvaluator().evaluateInvocations(
        [toolUsesInvocation([toolCall])],
        [toolUsesInvocation([toolCall, toolCall])],
      );
      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('scores 1.0 when there are no tool calls', () => {
      const invocation = toolUsesInvocation([]);
      const result = exactEvaluator().evaluateInvocations(
        [invocation],
        [invocation],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('averages scores across multiple invocations', () => {
      const toolCall1: FunctionCall = {
        name: 'test_func1',
        args: {arg1: 'val1'},
      };
      const toolCall2: FunctionCall = {
        name: 'test_func2',
        args: {arg1: 'val1'},
      };
      const result = exactEvaluator().evaluateInvocations(
        [toolUsesInvocation([toolCall1]), toolUsesInvocation([toolCall1])],
        [toolUsesInvocation([toolCall1]), toolUsesInvocation([toolCall2])],
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
    it('passes with extra tool calls', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const t1_1: FunctionCall = {name: 't1_1', args: {}};
      const t2: FunctionCall = {name: 't2', args: {}};
      const t2_1: FunctionCall = {name: 't2_1', args: {}};
      const t3: FunctionCall = {name: 't3', args: {}};
      const t3_1: FunctionCall = {name: 't3_1', args: {}};
      const result = inOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t1, t1_1, t2, t2_1, t3, t3_1])],
        [toolUsesInvocation([t1, t2, t3])],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('fails with a missing tool call', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const t1_1: FunctionCall = {name: 't1_1', args: {}};
      const t2: FunctionCall = {name: 't2', args: {}};
      const t2_1: FunctionCall = {name: 't2_1', args: {}};
      const t3_1: FunctionCall = {name: 't3_1', args: {}};
      const t4: FunctionCall = {name: 't4', args: {}};
      const result = inOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t1, t1_1, t2, t2_1, t3_1])],
        [toolUsesInvocation([t1, t2, t4])],
      );
      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('fails with the wrong order', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const t2: FunctionCall = {name: 't2', args: {}};
      const t3: FunctionCall = {name: 't3', args: {}};
      const result = inOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t1, t3, t2])],
        [toolUsesInvocation([t1, t2, t3])],
      );
      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('fails when actual is empty but expected is not', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const result = inOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([])],
        [toolUsesInvocation([t1])],
      );
      expect(result.overallScore).toBe(0.0);
    });

    it('passes when expected is empty', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const result = inOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t1])],
        [toolUsesInvocation([])],
      );
      expect(result.overallScore).toBe(1.0);
    });
  });

  describe('ANY_ORDER match', () => {
    it('passes with extra tool calls in a different order', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const t1_1: FunctionCall = {name: 't1_1', args: {}};
      const t2: FunctionCall = {name: 't2', args: {}};
      const t2_1: FunctionCall = {name: 't2_1', args: {}};
      const t3: FunctionCall = {name: 't3', args: {}};
      const t3_1: FunctionCall = {name: 't3_1', args: {}};
      const result = anyOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t2, t2_1, t1, t1_1, t3, t3_1])],
        [toolUsesInvocation([t1, t2, t3])],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('fails with a missing tool call', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const t1_1: FunctionCall = {name: 't1_1', args: {}};
      const t2: FunctionCall = {name: 't2', args: {}};
      const t2_1: FunctionCall = {name: 't2_1', args: {}};
      const t3_1: FunctionCall = {name: 't3_1', args: {}};
      const t4: FunctionCall = {name: 't4', args: {}};
      const result = anyOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t1, t1_1, t2, t2_1, t3_1])],
        [toolUsesInvocation([t1, t2, t4])],
      );
      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('passes with duplicates present in sufficient count', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const t2: FunctionCall = {name: 't2', args: {}};
      const t3: FunctionCall = {name: 't3', args: {}};
      const result = anyOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t1, t2, t3, t1])],
        [toolUsesInvocation([t1, t2, t1])],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('fails when a duplicate is missing', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const t2: FunctionCall = {name: 't2', args: {}};
      const t3: FunctionCall = {name: 't3', args: {}};
      const result = anyOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t1, t2, t3])],
        [toolUsesInvocation([t1, t2, t1])],
      );
      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('fails when actual is empty but expected is not', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const result = anyOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([])],
        [toolUsesInvocation([t1])],
      );
      expect(result.overallScore).toBe(0.0);
    });

    it('passes when expected is empty', () => {
      const t1: FunctionCall = {name: 't1', args: {}};
      const result = anyOrderEvaluator().evaluateInvocations(
        [toolUsesInvocation([t1])],
        [toolUsesInvocation([])],
      );
      expect(result.overallScore).toBe(1.0);
    });
  });

  describe('edge cases', () => {
    it('returns NOT_EVALUATED for no invocations', () => {
      const result = exactEvaluator().evaluateInvocations([], []);
      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
      expect(result.perInvocationResults).toHaveLength(0);
    });

    it('throws when expected invocations are missing', () => {
      expect(() =>
        exactEvaluator().evaluateInvocations([toolUsesInvocation([])]),
      ).toThrow('expected_invocations is needed by this metric.');
    });

    it('throws when invocation lengths differ', () => {
      expect(() =>
        exactEvaluator().evaluateInvocations(
          [toolUsesInvocation([]), toolUsesInvocation([])],
          [toolUsesInvocation([])],
        ),
      ).toThrow('same length; got 2 and 1');
    });
  });

  describe('InvocationEvents intermediate data format', () => {
    it('scores 1.0 on exact match ignoring the tool call id', () => {
      const actual = invocationEventsInvocation({
        id: 'toolu_01',
        name: 'execute_sql',
        args: {query: 'SELECT 1'},
      });
      const expected = invocationEventsInvocation({
        name: 'execute_sql',
        args: {query: 'SELECT 1'},
      });
      const result = exactEvaluator().evaluateInvocations([actual], [expected]);
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('scores 0.0 when tool calls differ', () => {
      const actual = invocationEventsInvocation({
        name: 'tool_a',
        args: {x: '1'},
      });
      const expected = invocationEventsInvocation({
        name: 'tool_b',
        args: {x: '1'},
      });
      const result = exactEvaluator().evaluateInvocations([actual], [expected]);
      expect(result.overallScore).toBe(0.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });
  });
});
