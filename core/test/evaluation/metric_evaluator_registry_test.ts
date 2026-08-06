/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CustomMetricEvaluator,
  DEFAULT_METRIC_EVALUATOR_REGISTRY,
  EvalConfigSchema,
  type EvalMetric,
  EvalStatus,
  type EvaluationResult,
  Evaluator,
  type EvaluatorConstructor,
  FinalResponseMatchV2EvaluatorMetricInfoProvider,
  HallucinationsV1EvaluatorMetricInfoProvider,
  type Invocation,
  InvocationSchema,
  MetricEvaluatorRegistry,
  type MetricInfo,
  MultiTurnTaskSuccessV1MetricInfoProvider,
  MultiTurnToolUseQualityV1MetricInfoProvider,
  MultiTurnTrajectoryQualityV1MetricInfoProvider,
  NotFoundError,
  PerTurnUserSimulatorQualityV1MetricInfoProvider,
  PrebuiltMetrics,
  registerCustomMetricsFromConfig,
  ResponseEvaluator,
  ResponseEvaluatorMetricInfoProvider,
  RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider,
  RubricBasedMultiTurnTrajectoryMetricInfoProvider,
  RubricBasedToolUseV1EvaluatorMetricInfoProvider,
  SafetyEvaluatorV1,
  SafetyEvaluatorV1MetricInfoProvider,
  TrajectoryEvaluator,
  TrajectoryEvaluatorMetricInfoProvider,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function intervalMetricInfo(
  metricName: string,
  description: string,
  minValue: number,
  maxValue: number,
): MetricInfo {
  return {
    metricName,
    description,
    metricValueInfo: {
      interval: {minValue, openAtMin: false, maxValue, openAtMax: false},
    },
  };
}

const DUMMY_METRIC_NAME = 'dummy_metric_name';
const DUMMY_METRIC_INFO = intervalMetricInfo(
  DUMMY_METRIC_NAME,
  'Dummy metric description',
  0.0,
  1.0,
);
const ANOTHER_DUMMY_METRIC_INFO = intervalMetricInfo(
  DUMMY_METRIC_NAME,
  'Another dummy metric description',
  0.0,
  1.0,
);

class DummyEvaluator extends Evaluator {
  constructor(readonly options: {evalMetric: EvalMetric}) {
    super();
  }
  evaluateInvocations(): EvaluationResult {
    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    };
  }
}

class AnotherDummyEvaluator extends Evaluator {
  constructor(readonly options: {evalMetric: EvalMetric}) {
    super();
  }
  evaluateInvocations(): EvaluationResult {
    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    };
  }
}

class SubclassedCustomMetricEvaluator extends CustomMetricEvaluator {}

function registeredMetricInfo(
  registry: MetricEvaluatorRegistry,
  metricName: string,
): MetricInfo | undefined {
  return registry
    .getRegisteredMetrics()
    .find((info) => info.metricName === metricName);
}

describe('evaluation/metric_evaluator_registry', () => {
  describe('MetricEvaluatorRegistry', () => {
    it('registers an evaluator', () => {
      const registry = new MetricEvaluatorRegistry();
      registry.registerEvaluator(DUMMY_METRIC_INFO, DummyEvaluator);
      const evaluator = registry.getEvaluator({
        metricName: DUMMY_METRIC_NAME,
        threshold: 0.5,
      });
      expect(evaluator).toBeInstanceOf(DummyEvaluator);
      expect(registeredMetricInfo(registry, DUMMY_METRIC_NAME)).toEqual(
        DUMMY_METRIC_INFO,
      );
    });

    it('updates an existing mapping', () => {
      const registry = new MetricEvaluatorRegistry();
      registry.registerEvaluator(DUMMY_METRIC_INFO, DummyEvaluator);
      registry.registerEvaluator(
        ANOTHER_DUMMY_METRIC_INFO,
        AnotherDummyEvaluator,
      );
      const evaluator = registry.getEvaluator({
        metricName: DUMMY_METRIC_NAME,
        threshold: 0.5,
      });
      expect(evaluator).toBeInstanceOf(AnotherDummyEvaluator);
      const matching = registry
        .getRegisteredMetrics()
        .filter((info) => info.metricName === DUMMY_METRIC_NAME);
      expect(matching).toHaveLength(1);
      expect(matching[0].description).toBe('Another dummy metric description');
    });

    it('throws NotFoundError for an unknown metric', () => {
      const registry = new MetricEvaluatorRegistry();
      expect(() =>
        registry.getEvaluator({
          metricName: 'non_existent_metric',
          threshold: 0.5,
        }),
      ).toThrow(NotFoundError);
    });

    it('returns deep copies from getRegisteredMetrics', () => {
      const registry = new MetricEvaluatorRegistry();
      registry.registerEvaluator(DUMMY_METRIC_INFO, DummyEvaluator);
      const first = registeredMetricInfo(registry, DUMMY_METRIC_NAME)!;
      first.description = 'mutated';
      const second = registeredMetricInfo(registry, DUMMY_METRIC_NAME)!;
      expect(second.description).toBe('Dummy metric description');
    });
  });

  describe('registerCustomMetricsFromConfig', () => {
    const CUSTOM_METRIC_NAME = 'custom_metric_for_registry_test';

    it('registers a custom metric with a provided metric info', () => {
      const registry = new MetricEvaluatorRegistry();
      const evalConfig = EvalConfigSchema.parse({
        customMetrics: {
          [CUSTOM_METRIC_NAME]: {
            codeConfig: {name: 'math.sqrt'},
            metricInfo: intervalMetricInfo(
              'name_to_be_overridden',
              'Custom metric description',
              0.0,
              5.0,
            ),
          },
        },
      });

      const result = registerCustomMetricsFromConfig(evalConfig, registry);

      expect(result).toBe(registry);
      const info = registeredMetricInfo(registry, CUSTOM_METRIC_NAME)!;
      expect(info.metricValueInfo.interval?.maxValue).toBe(5.0);
      expect(
        registry
          .getRegisteredMetrics()
          .every((m) => m.metricName !== 'name_to_be_overridden'),
      ).toBe(true);
      const evaluator = registry.getEvaluator({
        metricName: CUSTOM_METRIC_NAME,
        threshold: 0.5,
        customFunctionPath: 'math.sqrt',
      });
      expect(evaluator).toBeInstanceOf(CustomMetricEvaluator);
    });

    it('registers a custom metric with a default metric info', () => {
      const registry = new MetricEvaluatorRegistry();
      const evalConfig = EvalConfigSchema.parse({
        customMetrics: {
          [CUSTOM_METRIC_NAME]: {
            codeConfig: {name: 'math.sqrt'},
            description: 'A custom metric',
          },
        },
      });

      registerCustomMetricsFromConfig(evalConfig, registry);

      const info = registeredMetricInfo(registry, CUSTOM_METRIC_NAME)!;
      expect(info.description).toBe('A custom metric');
      expect(info.metricValueInfo.interval?.minValue).toBe(0.0);
      expect(info.metricValueInfo.interval?.maxValue).toBe(1.0);
    });

    it('is a no-op when there are no custom metrics', () => {
      const registry = new MetricEvaluatorRegistry();
      const before = registry.getRegisteredMetrics();
      const result = registerCustomMetricsFromConfig(
        EvalConfigSchema.parse({}),
        registry,
      );
      expect(result).toBe(registry);
      expect(registry.getRegisteredMetrics()).toEqual(before);
    });

    it('defaults to the DEFAULT_METRIC_EVALUATOR_REGISTRY', () => {
      const evalConfig = EvalConfigSchema.parse({
        customMetrics: {
          [CUSTOM_METRIC_NAME]: {codeConfig: {name: 'math.sqrt'}},
        },
      });

      const result = registerCustomMetricsFromConfig(evalConfig);

      expect(result).toBe(DEFAULT_METRIC_EVALUATOR_REGISTRY);
      expect(
        registeredMetricInfo(
          DEFAULT_METRIC_EVALUATOR_REGISTRY,
          CUSTOM_METRIC_NAME,
        )?.metricName,
      ).toBe(CUSTOM_METRIC_NAME);
    });

    it('constructs subclasses of CustomMetricEvaluator with the function path', () => {
      const registry = new MetricEvaluatorRegistry();
      registry.registerEvaluator(
        intervalMetricInfo('subclassed_custom', '', 0.0, 1.0),
        SubclassedCustomMetricEvaluator as unknown as EvaluatorConstructor,
      );
      const evaluator = registry.getEvaluator({
        metricName: 'subclassed_custom',
        threshold: 0.5,
        customFunctionPath: 'math.sqrt',
      });
      expect(evaluator).toBeInstanceOf(SubclassedCustomMetricEvaluator);
    });
  });

  describe('DEFAULT_METRIC_EVALUATOR_REGISTRY', () => {
    it('resolves the ported deterministic evaluators', () => {
      expect(
        DEFAULT_METRIC_EVALUATOR_REGISTRY.getEvaluator({
          metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
          threshold: 1.0,
        }),
      ).toBeInstanceOf(TrajectoryEvaluator);
      expect(
        DEFAULT_METRIC_EVALUATOR_REGISTRY.getEvaluator({
          metricName: PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
          threshold: 0.8,
        }),
      ).toBeInstanceOf(ResponseEvaluator);
      expect(
        DEFAULT_METRIC_EVALUATOR_REGISTRY.getEvaluator({
          metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
          threshold: 0.8,
        }),
      ).toBeInstanceOf(ResponseEvaluator);
      expect(
        DEFAULT_METRIC_EVALUATOR_REGISTRY.getEvaluator({
          metricName: PrebuiltMetrics.SAFETY_V1,
          threshold: 0.8,
        }),
      ).toBeInstanceOf(SafetyEvaluatorV1);
    });

    it('scores a hand-built trajectory pair end-to-end', async () => {
      const evaluator = DEFAULT_METRIC_EVALUATOR_REGISTRY.getEvaluator({
        metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
        threshold: 1.0,
      });
      const invocation: Invocation = InvocationSchema.parse({
        userContent: {parts: [{text: 'hi'}]},
        intermediateData: {toolUses: [{name: 'search', args: {q: '1'}}]},
      });
      const result = await evaluator.evaluateInvocations(
        [invocation],
        [invocation],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('scores a hand-built response-match pair end-to-end', async () => {
      const evaluator = DEFAULT_METRIC_EVALUATOR_REGISTRY.getEvaluator({
        metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
        threshold: 0.8,
      });
      const actual: Invocation = InvocationSchema.parse({
        userContent: {parts: [{text: 'hi'}]},
        finalResponse: {parts: [{text: 'the same words'}]},
      });
      const result = await evaluator.evaluateInvocations([actual], [actual]);
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });
  });

  describe('MetricInfoProviders', () => {
    it('TrajectoryEvaluatorMetricInfoProvider', () => {
      const info = new TrajectoryEvaluatorMetricInfoProvider().getMetricInfo();
      expect(info.metricName).toBe(PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE);
      expect(info.metricValueInfo.interval?.minValue).toBe(0.0);
      expect(info.metricValueInfo.interval?.maxValue).toBe(1.0);
    });

    it('ResponseEvaluatorMetricInfoProvider (evaluation score)', () => {
      const info = new ResponseEvaluatorMetricInfoProvider(
        PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
      ).getMetricInfo();
      expect(info.metricName).toBe(PrebuiltMetrics.RESPONSE_EVALUATION_SCORE);
      expect(info.metricValueInfo.interval?.minValue).toBe(1.0);
      expect(info.metricValueInfo.interval?.maxValue).toBe(5.0);
    });

    it('ResponseEvaluatorMetricInfoProvider (match score)', () => {
      const info = new ResponseEvaluatorMetricInfoProvider(
        PrebuiltMetrics.RESPONSE_MATCH_SCORE,
      ).getMetricInfo();
      expect(info.metricName).toBe(PrebuiltMetrics.RESPONSE_MATCH_SCORE);
      expect(info.metricValueInfo.interval?.minValue).toBe(0.0);
      expect(info.metricValueInfo.interval?.maxValue).toBe(1.0);
    });

    it('ResponseEvaluatorMetricInfoProvider throws for an unsupported metric', () => {
      expect(() =>
        new ResponseEvaluatorMetricInfoProvider('bogus').getMetricInfo(),
      ).toThrow('`bogus` is not supported.');
    });

    it.each<[{new (): {getMetricInfo(): MetricInfo}}, PrebuiltMetrics]>([
      [SafetyEvaluatorV1MetricInfoProvider, PrebuiltMetrics.SAFETY_V1],
      [
        MultiTurnTaskSuccessV1MetricInfoProvider,
        PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
      ],
      [
        MultiTurnTrajectoryQualityV1MetricInfoProvider,
        PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
      ],
      [
        MultiTurnToolUseQualityV1MetricInfoProvider,
        PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
      ],
      [
        FinalResponseMatchV2EvaluatorMetricInfoProvider,
        PrebuiltMetrics.FINAL_RESPONSE_MATCH_V2,
      ],
      [
        RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider,
        PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      ],
      [
        HallucinationsV1EvaluatorMetricInfoProvider,
        PrebuiltMetrics.HALLUCINATIONS_V1,
      ],
      [
        RubricBasedToolUseV1EvaluatorMetricInfoProvider,
        PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
      ],
      [
        PerTurnUserSimulatorQualityV1MetricInfoProvider,
        PrebuiltMetrics.PER_TURN_USER_SIMULATOR_QUALITY_V1,
      ],
      [
        RubricBasedMultiTurnTrajectoryMetricInfoProvider,
        PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
      ],
    ])('%p reports name and [0,1] bounds', (ProviderClass, metricName) => {
      const info = new ProviderClass().getMetricInfo();
      expect(info.metricName).toBe(metricName);
      expect(info.metricValueInfo.interval?.minValue).toBe(0.0);
      expect(info.metricValueInfo.interval?.maxValue).toBe(1.0);
    });
  });
});
