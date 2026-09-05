/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the metric info providers,
 * which describe each prebuilt metric, and the eval data model they describe
 * it with.
 */

export {PrebuiltMetrics, parseMetricInfo} from './eval_metrics.js';
export type {
  Interval,
  MetricInfo,
  MetricInfoProvider,
  MetricValueInfo,
} from './eval_metrics.js';
export {
  FinalResponseMatchV2EvaluatorMetricInfoProvider,
  HallucinationsV1EvaluatorMetricInfoProvider,
  MultiTurnTaskSuccessV1MetricInfoProvider,
  MultiTurnToolUseQualityV1MetricInfoProvider,
  MultiTurnTrajectoryQualityV1MetricInfoProvider,
  PerTurnUserSimulatorQualityV1MetricInfoProvider,
  ResponseEvaluatorMetricInfoProvider,
  RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider,
  RubricBasedMultiTurnTrajectoryMetricInfoProvider,
  RubricBasedToolUseV1EvaluatorMetricInfoProvider,
  SafetyEvaluatorV1MetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
} from './metric_info_providers.js';
