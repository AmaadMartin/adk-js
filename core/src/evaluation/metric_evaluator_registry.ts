/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError} from '../errors/not_found_error.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {EvalMetric, PrebuiltMetrics} from './eval_metrics.js';
import {Evaluator} from './evaluator.js';
import {ResponseEvaluator} from './response_evaluator.js';
import {TrajectoryEvaluator} from './trajectory_evaluator.js';

/** Builds an evaluator for one metric configuration. */
export type MetricEvaluatorFactory = (evalMetric: EvalMetric) => Evaluator;

/** The evaluators ADK ships, seeded into every registry. */
const STANDARD_METRIC_EVALUATORS: ReadonlyArray<
  [PrebuiltMetrics, MetricEvaluatorFactory]
> = [
  [
    PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
    (evalMetric) => new TrajectoryEvaluator({evalMetric}),
  ],
  [
    PrebuiltMetrics.RESPONSE_MATCH_SCORE,
    (evalMetric) => new ResponseEvaluator({evalMetric}),
  ],
  [
    PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    (evalMetric) => new ResponseEvaluator({evalMetric}),
  ],
];

/**
 * Resolves a metric name to an evaluator.
 *
 * Each registry owns its own registrations, so a metric registered for one app
 * is not resolvable from another app's registry. The metrics ADK ships are
 * seeded into every registry, as they are the same everywhere.
 */
@experimental
export class MetricEvaluatorRegistry {
  private readonly factories = new Map<string, MetricEvaluatorFactory>(
    STANDARD_METRIC_EVALUATORS,
  );

  /**
   * Returns a new evaluator for the metric.
   *
   * @throws {NotFoundError} When no evaluator is registered under the metric
   *   name.
   */
  getEvaluator(evalMetric: EvalMetric): Evaluator {
    const factory = this.factories.get(evalMetric.metricName);
    if (!factory) {
      throw new NotFoundError(
        `${evalMetric.metricName} not found in registry.`,
      );
    }
    return factory(evalMetric);
  }

  /** Registers a factory, replacing any already under that name. */
  registerEvaluator(metricName: string, factory: MetricEvaluatorFactory): void {
    if (this.factories.has(metricName)) {
      logger.debug(
        `Overwriting the evaluator registered for metric ${metricName}.`,
      );
    }
    this.factories.set(metricName, factory);
  }
}

let defaultRegistry: MetricEvaluatorRegistry | undefined;

/**
 * The registry a {@link MetricEvaluatorRegistry} consumer gets when it
 * supplies none. Built on first use, then reused.
 */
export function defaultMetricEvaluatorRegistry(): MetricEvaluatorRegistry {
  defaultRegistry ??= new MetricEvaluatorRegistry();
  return defaultRegistry;
}
