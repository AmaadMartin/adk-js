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

/**
 * Resolves a metric name to the evaluator that scores it.
 *
 * Each instance owns its own factories, so a metric registered for one app is
 * not resolvable from another app's registry. The metrics that ship with ADK
 * are seeded into every instance, because they are the same everywhere.
 */
@experimental
export class MetricEvaluatorRegistry {
  private readonly factories = new Map<string, MetricEvaluatorFactory>();

  constructor() {
    registerStandardMetrics(this);
  }

  /**
   * Returns a fresh evaluator for `evalMetric`.
   *
   * @throws {NotFoundError} When no evaluator is registered for the metric.
   */
  getEvaluator(evalMetric: EvalMetric): Evaluator {
    const factory = this.factories.get(evalMetric.metricName);
    if (factory === undefined) {
      throw new NotFoundError(
        `${evalMetric.metricName} not found in registry.`,
      );
    }
    return factory(evalMetric);
  }

  /** Registers a factory, replacing any factory already under that name. */
  registerEvaluator(metricName: string, factory: MetricEvaluatorFactory): void {
    if (this.factories.has(metricName)) {
      logger.debug(`Replacing the evaluator registered for ${metricName}.`);
    }
    this.factories.set(metricName, factory);
  }
}

/**
 * Registers the metrics that ship with ADK.
 *
 * `response_evaluation_score` is scored by the Vertex AI Gen AI evaluation
 * service, which has no JavaScript SDK, so its transport is injected. The
 * seeded factory builds a `ResponseEvaluator` without one, which rejects the
 * call and names the missing client. That is a better report than the
 * "not found" an unregistered name would produce, and a caller that has a
 * client registers a factory that supplies it.
 */
function registerStandardMetrics(registry: MetricEvaluatorRegistry): void {
  registry.registerEvaluator(
    PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
    (evalMetric) => new TrajectoryEvaluator({evalMetric}),
  );
  registry.registerEvaluator(
    PrebuiltMetrics.RESPONSE_MATCH_SCORE,
    (evalMetric) => new ResponseEvaluator({evalMetric}),
  );
  registry.registerEvaluator(
    PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    (evalMetric) => new ResponseEvaluator({evalMetric}),
  );
}

let defaultRegistry: MetricEvaluatorRegistry | undefined;

/**
 * Returns the registry a {@link LocalEvalService} uses when given none.
 *
 * Built on first use rather than at module load. This module hangs off the
 * package barrel, so constructing an `@experimental` class here would warn
 * every consumer of `@google/adk` and consume the once-per-class warning slot
 * before a caller who actually builds a registry can see it.
 */
export function defaultMetricEvaluatorRegistry(): MetricEvaluatorRegistry {
  return (defaultRegistry ??= new MetricEvaluatorRegistry());
}
