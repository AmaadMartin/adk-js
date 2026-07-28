/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError} from '../errors/not_found_error.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {CustomMetricEvaluator} from './custom_metric_evaluator.js';
import {EvalConfig} from './eval_config.js';
import {EvalMetric, MetricInfo, PrebuiltMetrics} from './eval_metrics.js';
import {Evaluator} from './evaluator.js';
import {
  ResponseEvaluatorMetricInfoProvider,
  SafetyEvaluatorV1MetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
} from './metric_info_providers.js';
import {ResponseEvaluator} from './response_evaluator.js';
import {SafetyEvaluatorV1} from './safety_evaluator.js';
import {TrajectoryEvaluator} from './trajectory_evaluator.js';

// Providers are re-exported here for parity with adk-python, whose registry
// module re-exports them (the registry tests import them from here).
export * from './metric_info_providers.js';

/**
 * The options an evaluator constructor may receive from the registry. The
 * registry always supplies `evalMetric`; each concrete evaluator reads the
 * subset of fields it needs.
 */
export interface EvaluatorConstructorOptions {
  evalMetric: EvalMetric;
  threshold?: number;
  metricName?: string;
  customFunctionPath?: string;
}

/**
 * A constructor for an {@link Evaluator} that can be registered in the registry.
 */
export type EvaluatorConstructor = new (
  options: EvaluatorConstructorOptions,
) => Evaluator;

function isCustomMetricEvaluatorConstructor(
  evaluator: EvaluatorConstructor,
): boolean {
  return (
    evaluator === (CustomMetricEvaluator as unknown as EvaluatorConstructor) ||
    evaluator.prototype instanceof CustomMetricEvaluator
  );
}

/**
 * A registry for metric {@link Evaluator}s.
 *
 * Unlike adk-python, which stores the registry as class-level shared state, this
 * uses an instance-level map. {@link DEFAULT_METRIC_EVALUATOR_REGISTRY} is a
 * module-level singleton. No behavior depends on cross-instance sharing, and
 * this removes the shared-mutable-state hazard.
 */
@experimental
export class MetricEvaluatorRegistry {
  private readonly registry = new Map<
    string,
    [EvaluatorConstructor, MetricInfo]
  >();

  /**
   * Returns a new {@link Evaluator} instance for the given metric.
   *
   * @throws {NotFoundError} If there is no evaluator for the metric.
   */
  getEvaluator(evalMetric: EvalMetric): Evaluator {
    const entry = this.registry.get(evalMetric.metricName);
    if (entry === undefined) {
      throw new NotFoundError(
        `${evalMetric.metricName} not found in registry.`,
      );
    }

    const [evaluatorType] = entry;
    if (isCustomMetricEvaluatorConstructor(evaluatorType)) {
      return new evaluatorType({
        evalMetric,
        customFunctionPath: evalMetric.customFunctionPath,
      });
    }
    return new evaluatorType({evalMetric});
  }

  /**
   * Registers an evaluator for the given metric info, updating any existing
   * mapping.
   */
  registerEvaluator(
    metricInfo: MetricInfo,
    evaluator: EvaluatorConstructor,
  ): void {
    const metricName = metricInfo.metricName;
    if (this.registry.has(metricName)) {
      logger.debug(`Updating Evaluator class for ${metricName}.`);
    }
    this.registry.set(metricName, [evaluator, metricInfo]);
  }

  /**
   * Returns deep copies of the {@link MetricInfo} for all registered metrics.
   */
  getRegisteredMetrics(): MetricInfo[] {
    return [...this.registry.values()].map(([, metricInfo]) =>
      structuredClone(metricInfo),
    );
  }
}

function getDefaultMetricEvaluatorRegistry(): MetricEvaluatorRegistry {
  const registry = new MetricEvaluatorRegistry();

  registry.registerEvaluator(
    new TrajectoryEvaluatorMetricInfoProvider().getMetricInfo(),
    TrajectoryEvaluator,
  );
  registry.registerEvaluator(
    new ResponseEvaluatorMetricInfoProvider(
      PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    ).getMetricInfo(),
    ResponseEvaluator,
  );
  registry.registerEvaluator(
    new ResponseEvaluatorMetricInfoProvider(
      PrebuiltMetrics.RESPONSE_MATCH_SCORE,
    ).getMetricInfo(),
    ResponseEvaluator,
  );
  registry.registerEvaluator(
    new SafetyEvaluatorV1MetricInfoProvider().getMetricInfo(),
    SafetyEvaluatorV1,
  );

  return registry;
}

/**
 * A singleton {@link MetricEvaluatorRegistry} preloaded with the deterministic
 * evaluators ported in this module.
 */
export const DEFAULT_METRIC_EVALUATOR_REGISTRY =
  getDefaultMetricEvaluatorRegistry();

function getDefaultMetricInfo(
  metricName: string,
  description = '',
): MetricInfo {
  return {
    metricName,
    description,
    metricValueInfo: {
      interval: {
        minValue: 0.0,
        openAtMin: false,
        maxValue: 1.0,
        openAtMax: false,
      },
    },
  };
}

/**
 * Registers custom metrics declared in the given eval config.
 *
 * Entries with a `metricInfo` reuse it (copied, with `metricName` overridden to
 * the map key); entries without one get a default `MetricInfo` with a [0, 1]
 * value interval. Each is registered against {@link CustomMetricEvaluator}.
 *
 * @param evalConfig The eval config whose `customMetrics` should be registered.
 * @param metricEvaluatorRegistry The registry to register into. Defaults to
 *     {@link DEFAULT_METRIC_EVALUATOR_REGISTRY}.
 * @returns The registry the metrics were registered in.
 */
export function registerCustomMetricsFromConfig(
  evalConfig: EvalConfig,
  metricEvaluatorRegistry: MetricEvaluatorRegistry = DEFAULT_METRIC_EVALUATOR_REGISTRY,
): MetricEvaluatorRegistry {
  const customMetrics = evalConfig.customMetrics;
  if (customMetrics === undefined || Object.keys(customMetrics).length === 0) {
    return metricEvaluatorRegistry;
  }

  for (const [metricName, config] of Object.entries(customMetrics)) {
    const metricInfo: MetricInfo = config.metricInfo
      ? {...structuredClone(config.metricInfo), metricName}
      : getDefaultMetricInfo(metricName, config.description);
    metricEvaluatorRegistry.registerEvaluator(
      metricInfo,
      CustomMetricEvaluator as unknown as EvaluatorConstructor,
    );
  }

  return metricEvaluatorRegistry;
}
