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
import {
  EvalMetric,
  MetricInfo,
  MetricInfoProvider,
  PrebuiltMetrics,
} from './eval_metrics.js';
import {Evaluator} from './evaluator.js';
import {
  ResponseEvaluatorMetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
} from './metric_info_providers.js';
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
  private readonly infoProviders = new Map<string, MetricInfoProvider>();

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

  /**
   * Registers a factory, replacing any factory already under that name.
   *
   * @param metricName The metric the factory scores.
   * @param factory Builds the evaluator for one configuration of the metric.
   * @param infoProvider Describes the metric to a caller listing what this
   *   registry can score. A metric registered without one is resolvable but
   *   not listed, because there is nothing to say about it.
   */
  registerEvaluator(
    metricName: string,
    factory: MetricEvaluatorFactory,
    infoProvider?: MetricInfoProvider,
  ): void {
    if (this.factories.has(metricName)) {
      logger.debug(`Replacing the evaluator registered for ${metricName}.`);
    }
    this.factories.set(metricName, factory);
    if (infoProvider) {
      this.infoProviders.set(metricName, infoProvider);
    }
  }

  /**
   * Describes every metric this registry can both score and describe.
   *
   * adk-js seeds fewer standard metrics than adk-python does, so this list is
   * shorter than the one adk-python's registry returns.
   */
  getRegisteredMetrics(): MetricInfo[] {
    return [...this.infoProviders.values()].map((provider) =>
      provider.getMetricInfo(),
    );
  }

  /**
   * Returns an isolated copy of this registry.
   *
   * The copy starts out with everything registered here, so evaluators that a
   * caller registered on the default registry stay resolvable. Registrations
   * made afterwards on either registry are invisible to the other, which is
   * what makes it safe to register the custom metrics of a single eval run
   * without mutating process-wide state.
   */
  fork(): MetricEvaluatorRegistry {
    const forked = new MetricEvaluatorRegistry();
    for (const [metricName, factory] of this.factories) {
      forked.factories.set(metricName, factory);
    }
    for (const [metricName, provider] of this.infoProviders) {
      forked.infoProviders.set(metricName, provider);
    }
    return forked;
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
    new TrajectoryEvaluatorMetricInfoProvider(),
  );
  registry.registerEvaluator(
    PrebuiltMetrics.RESPONSE_MATCH_SCORE,
    (evalMetric) => new ResponseEvaluator({evalMetric}),
    new ResponseEvaluatorMetricInfoProvider(
      PrebuiltMetrics.RESPONSE_MATCH_SCORE,
    ),
  );
  registry.registerEvaluator(
    PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    (evalMetric) => new ResponseEvaluator({evalMetric}),
    new ResponseEvaluatorMetricInfoProvider(
      PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    ),
  );
}

let defaultRegistry: MetricEvaluatorRegistry | undefined;

/**
 * Returns the registry an eval service uses when given none.
 *
 * Built on first use rather than at module load. This module hangs off the
 * package barrel, so constructing an `@experimental` class here would warn
 * every consumer of `@google/adk` and consume the once-per-class warning slot
 * before a caller who actually builds a registry can see it.
 */
export function defaultMetricEvaluatorRegistry(): MetricEvaluatorRegistry {
  return (defaultRegistry ??= new MetricEvaluatorRegistry());
}

/**
 * Registers the custom metrics an eval config declares.
 *
 * A config with no custom metrics leaves the registry untouched. Register into
 * a {@link MetricEvaluatorRegistry.fork} so the run's registrations do not
 * reach process-wide state.
 *
 * @param evalConfig The config whose `customMetrics` entries to register.
 * @param registry The registry to register them in.
 * @returns The registry the metrics were registered in.
 */
export function registerCustomMetricsFromConfig(
  evalConfig: EvalConfig,
  registry: MetricEvaluatorRegistry,
): MetricEvaluatorRegistry {
  for (const [metricName, config] of Object.entries(
    evalConfig.customMetrics ?? {},
  )) {
    registry.registerEvaluator(
      metricName,
      (evalMetric) =>
        new CustomMetricEvaluator(evalMetric, config.codeConfig.name),
    );
  }
  return registry;
}
