/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from `google/adk-python`, file
 * `tests/unittests/evaluation/test_metric_evaluator_registry.py`, class
 * `TestMetricInfoProviders`, at `main`. Each `it(...)` string is the reference
 * test method name, so a reviewer can grep it against the Python file.
 *
 * One reference test, `test_every_prebuilt_metric_is_registered_by_default`,
 * is not ported. See the pull request body.
 */

import {
  FinalResponseMatchV2EvaluatorMetricInfoProvider,
  HallucinationsV1EvaluatorMetricInfoProvider,
  MultiTurnTaskSuccessV1MetricInfoProvider,
  MultiTurnToolUseQualityV1MetricInfoProvider,
  MultiTurnTrajectoryQualityV1MetricInfoProvider,
  PerTurnUserSimulatorQualityV1MetricInfoProvider,
  PrebuiltMetrics,
  ResponseEvaluatorMetricInfoProvider,
  RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider,
  RubricBasedMultiTurnTrajectoryMetricInfoProvider,
  RubricBasedToolUseV1EvaluatorMetricInfoProvider,
  SafetyEvaluatorV1MetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('metric info providers', () => {
  it('test_trajectory_evaluator_metric_info_provider', () => {
    const metricInfo =
      new TrajectoryEvaluatorMetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_response_evaluator_metric_info_provider_eval_score', () => {
    const metricInfo = new ResponseEvaluatorMetricInfoProvider(
      PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    ).getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(1.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(5.0);
  });

  it('test_response_evaluator_metric_info_provider_match_score', () => {
    const metricInfo = new ResponseEvaluatorMetricInfoProvider(
      PrebuiltMetrics.RESPONSE_MATCH_SCORE,
    ).getMetricInfo();

    expect(metricInfo.metricName).toBe(PrebuiltMetrics.RESPONSE_MATCH_SCORE);
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_safety_evaluator_v1_metric_info_provider', () => {
    const metricInfo =
      new SafetyEvaluatorV1MetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(PrebuiltMetrics.SAFETY_V1);
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_final_response_match_v2_evaluator_metric_info_provider', () => {
    const metricInfo =
      new FinalResponseMatchV2EvaluatorMetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(PrebuiltMetrics.FINAL_RESPONSE_MATCH_V2);
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_rubric_based_final_response_quality_v1_evaluator_metric_info_provider', () => {
    const metricInfo =
      new RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_hallucinations_v1_evaluator_metric_info_provider', () => {
    const metricInfo =
      new HallucinationsV1EvaluatorMetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(PrebuiltMetrics.HALLUCINATIONS_V1);
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_rubric_based_tool_use_v1_evaluator_metric_info_provider', () => {
    const metricInfo =
      new RubricBasedToolUseV1EvaluatorMetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_per_turn_user_simulator_quality_v1_metric_info_provider', () => {
    const metricInfo =
      new PerTurnUserSimulatorQualityV1MetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.PER_TURN_USER_SIMULATOR_QUALITY_V1,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_rubric_based_multi_turn_trajectory_metric_info_provider', () => {
    const metricInfo =
      new RubricBasedMultiTurnTrajectoryMetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_multi_turn_task_success_v1_metric_info_provider', () => {
    const metricInfo =
      new MultiTurnTaskSuccessV1MetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_multi_turn_trajectory_quality_v1_metric_info_provider', () => {
    const metricInfo =
      new MultiTurnTrajectoryQualityV1MetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_multi_turn_tool_use_quality_v1_metric_info_provider', () => {
    const metricInfo =
      new MultiTurnToolUseQualityV1MetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0.0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1.0);
  });

  it('test_providers_cover_every_prebuilt_metric_exactly_once', () => {
    const metricNames = [
      new TrajectoryEvaluatorMetricInfoProvider(),
      new ResponseEvaluatorMetricInfoProvider(
        PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
      ),
      new ResponseEvaluatorMetricInfoProvider(
        PrebuiltMetrics.RESPONSE_MATCH_SCORE,
      ),
      new SafetyEvaluatorV1MetricInfoProvider(),
      new MultiTurnTaskSuccessV1MetricInfoProvider(),
      new MultiTurnTrajectoryQualityV1MetricInfoProvider(),
      new MultiTurnToolUseQualityV1MetricInfoProvider(),
      new FinalResponseMatchV2EvaluatorMetricInfoProvider(),
      new RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider(),
      new HallucinationsV1EvaluatorMetricInfoProvider(),
      new RubricBasedToolUseV1EvaluatorMetricInfoProvider(),
      new PerTurnUserSimulatorQualityV1MetricInfoProvider(),
      new RubricBasedMultiTurnTrajectoryMetricInfoProvider(),
    ].map((provider) => provider.getMetricInfo().metricName);

    // Two providers claiming the same name would silently overwrite each
    // other's evaluator when the default registry is built.
    expect(new Set(metricNames).size).toBe(metricNames.length);
    expect(new Set(metricNames)).toEqual(
      new Set(Object.values(PrebuiltMetrics)),
    );
  });
});
