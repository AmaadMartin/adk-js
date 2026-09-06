/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCriterionSchema,
  EvalMetricResultDetailsSchema,
  EvalMetricResultPerInvocationSchema,
  EvalMetricResultSchema,
  EvalMetricSchema,
  EvalStatus,
  HallucinationsCriterionSchema,
  IntervalSchema,
  JudgeModelOptionsSchema,
  LlmAsAJudgeCriterionSchema,
  LlmBackedUserSimulatorCriterionSchema,
  MatchType,
  type MetricInfo,
  type MetricInfoProvider,
  MetricInfoSchema,
  MetricValueInfoSchema,
  PrebuiltMetrics,
  RubricsBasedCriterionSchema,
  ToolTrajectoryCriterionSchema,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('evaluation/eval_metrics', () => {
  describe('enums', () => {
    it('EvalStatus uses the adk-python integer values', () => {
      expect(EvalStatus.PASSED).toBe(1);
      expect(EvalStatus.FAILED).toBe(2);
      expect(EvalStatus.NOT_EVALUATED).toBe(3);
    });

    it('PrebuiltMetrics uses the exact string values', () => {
      expect(PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE).toBe(
        'tool_trajectory_avg_score',
      );
      expect(
        PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
      ).toBe('rubric_based_multi_turn_trajectory_quality_v1');
    });

    it('MatchType uses the adk-python integer values', () => {
      expect(MatchType.EXACT).toBe(0);
      expect(MatchType.IN_ORDER).toBe(1);
      expect(MatchType.ANY_ORDER).toBe(2);
    });
  });

  describe('JudgeModelOptionsSchema', () => {
    it('applies defaults', () => {
      const options = JudgeModelOptionsSchema.parse({});
      expect(options.judgeModel).toBe('gemini-2.5-flash');
      expect(options.numSamples).toBe(5);
      expect(options.judgeModelConfig).toBeUndefined();
    });
  });

  describe('BaseCriterionSchema', () => {
    it('applies defaults and preserves unknown keys (loose)', () => {
      const criterion = BaseCriterionSchema.parse({
        threshold: 0.75,
        extraField: 'kept',
      });
      expect(criterion.threshold).toBe(0.75);
      expect(criterion.includeIntermediateResponsesInFinal).toBe(false);
      expect((criterion as Record<string, unknown>)['extraField']).toBe('kept');
    });

    it('requires a threshold', () => {
      expect(BaseCriterionSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('criterion subclasses', () => {
    it('LlmAsAJudgeCriterion defaults judgeModelOptions', () => {
      const criterion = LlmAsAJudgeCriterionSchema.parse({threshold: 1});
      expect(criterion.judgeModelOptions.judgeModel).toBe('gemini-2.5-flash');
    });

    it('RubricsBasedCriterion defaults rubrics to an empty array', () => {
      const criterion = RubricsBasedCriterionSchema.parse({threshold: 1});
      expect(criterion.rubrics).toEqual([]);
      expect(criterion.judgeModelOptions.numSamples).toBe(5);
    });

    it('HallucinationsCriterion defaults evaluateIntermediateNlResponses', () => {
      const criterion = HallucinationsCriterionSchema.parse({threshold: 1});
      expect(criterion.evaluateIntermediateNlResponses).toBe(false);
    });

    it('LlmBackedUserSimulatorCriterion defaults stopSignal', () => {
      const criterion = LlmBackedUserSimulatorCriterionSchema.parse({
        threshold: 1,
      });
      expect(criterion.stopSignal).toBe('</finished>');
      expect(criterion.judgeModelOptions.judgeModel).toBe('gemini-2.5-flash');
    });
  });

  describe('ToolTrajectoryCriterion matchType coercion', () => {
    it('defaults to EXACT', () => {
      expect(
        ToolTrajectoryCriterionSchema.parse({threshold: 1}).matchType,
      ).toBe(MatchType.EXACT);
    });

    it.each([
      ['exact', MatchType.EXACT],
      ['in-order', MatchType.IN_ORDER],
      ['ANY ORDER', MatchType.ANY_ORDER],
    ])('coerces the string %s', (input, expected) => {
      expect(
        ToolTrajectoryCriterionSchema.parse({threshold: 1, matchType: input})
          .matchType,
      ).toBe(expected);
    });

    it('accepts a MatchType enum value', () => {
      expect(
        ToolTrajectoryCriterionSchema.parse({
          threshold: 1,
          matchType: MatchType.ANY_ORDER,
        }).matchType,
      ).toBe(MatchType.ANY_ORDER);
    });

    it('rejects an unknown match type', () => {
      expect(
        ToolTrajectoryCriterionSchema.safeParse({
          threshold: 1,
          matchType: 'nope',
        }).success,
      ).toBe(false);
    });
  });

  describe('EvalMetricSchema', () => {
    it('parses with a base criterion and rejects unknown keys', () => {
      const metric = EvalMetricSchema.parse({
        metricName: 'tool_trajectory_avg_score',
        threshold: 0.5,
        criterion: {threshold: 0.5, subclassField: 'kept'},
      });
      expect(metric.metricName).toBe('tool_trajectory_avg_score');
      expect(
        (metric.criterion as Record<string, unknown>)['subclassField'],
      ).toBe('kept');
      expect(
        EvalMetricSchema.safeParse({metricName: 'm', extra: 1}).success,
      ).toBe(false);
    });
  });

  describe('EvalMetricResultSchema', () => {
    it('requires evalStatus and defaults details', () => {
      const result = EvalMetricResultSchema.parse({
        metricName: 'm',
        evalStatus: EvalStatus.PASSED,
      });
      expect(result.evalStatus).toBe(EvalStatus.PASSED);
      expect(result.details).toEqual({});
      expect(result.score).toBeUndefined();
    });

    it('fails without evalStatus', () => {
      expect(EvalMetricResultSchema.safeParse({metricName: 'm'}).success).toBe(
        false,
      );
    });
  });

  describe('EvalMetricResultDetailsSchema', () => {
    it('leaves rubricScores undefined by default', () => {
      expect(
        EvalMetricResultDetailsSchema.parse({}).rubricScores,
      ).toBeUndefined();
    });
  });

  describe('EvalMetricResultPerInvocationSchema', () => {
    it('defaults evalMetricResults and requires actualInvocation', () => {
      const userContent: Content = {role: 'user', parts: [{text: 'hi'}]};
      const perInvocation = EvalMetricResultPerInvocationSchema.parse({
        actualInvocation: {userContent},
      });
      expect(perInvocation.evalMetricResults).toEqual([]);
      expect(perInvocation.expectedInvocation).toBeUndefined();
    });
  });

  describe('IntervalSchema', () => {
    it('defaults openAtMin and openAtMax to false', () => {
      const interval = IntervalSchema.parse({minValue: 0, maxValue: 1});
      expect(interval.openAtMin).toBe(false);
      expect(interval.openAtMax).toBe(false);
    });
  });

  describe('MetricValueInfoSchema', () => {
    it('leaves interval undefined by default', () => {
      expect(MetricValueInfoSchema.parse({}).interval).toBeUndefined();
    });
  });

  describe('MetricInfoSchema', () => {
    it('defaults description to an empty string', () => {
      const info = MetricInfoSchema.parse({
        metricName: 'm',
        metricValueInfo: {interval: {minValue: 0, maxValue: 1}},
      });
      expect(info.description).toBe('');
    });
  });

  describe('MetricInfoProvider', () => {
    it('can be implemented to return MetricInfo', () => {
      const provider: MetricInfoProvider = {
        getMetricInfo(): MetricInfo {
          return MetricInfoSchema.parse({
            metricName: 'm',
            metricValueInfo: {},
          });
        },
      };
      expect(provider.getMetricInfo().metricName).toBe('m');
    });
  });
});
