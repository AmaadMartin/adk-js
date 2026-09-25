/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seam between {@link AgentEvaluator} and the service that scores an
 * agent.
 *
 * The data model, the config helpers and the eval-set migration utilities in
 * this directory stand alone. Running an eval additionally needs an eval
 * service, which this build of `@google/adk` does not ship.
 *
 * `LocalEvalService` is the implementation that will call
 * {@link setEvalRuntime}, once it is ported. It owns the user simulator, and
 * {@link EvalServiceParams} carries the eval config whole rather than the
 * metrics alone, because the service also reads its live-model settings.
 *
 * The runtime is installed process-wide, and deliberately so: adk-python
 * resolves the same service through a lazy module import, and a test author
 * calling `AgentEvaluator.evaluate` should not have to thread a factory
 * through every call.
 */

import {BaseAgent} from '../agents/base_agent.js';
import {App} from '../apps/app.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {BaseEvalService} from './base_eval_service.js';
import {MISSING_EVAL_DEPENDENCIES_MESSAGE} from './constants.js';
import {EvalConfig} from './eval_config.js';
import {EvalSetResultsManager} from './eval_set_results_manager.js';
import {EvalSetsManager} from './eval_sets_manager.js';
import {MetricEvaluatorRegistry} from './metric_evaluator_registry.js';

/** Everything the eval runtime needs to build a service for one run. */
export interface EvalServiceParams {
  /** The agent to score, already resolved from the caller's module. */
  rootAgent: BaseAgent;

  /** The app wrapping the agent, when its module exposes one. */
  app?: App;

  /** Holds the eval set this run scores. */
  evalSetsManager: EvalSetsManager;

  /**
   * The config of this run, whole. It carries `customMetrics`,
   * `userSimulatorConfig` and `liveModelConfig`, which the runtime owns.
   */
  evalConfig: EvalConfig;

  /**
   * Resolves a metric name to the evaluator that scores it.
   *
   * A fork private to this run, already carrying the custom metrics the
   * config declares, so registering them leaves the process-wide default
   * registry untouched.
   */
  metricEvaluatorRegistry?: MetricEvaluatorRegistry;

  /** Loads the artifacts the eval cases reach for. */
  artifactService?: BaseArtifactService;

  /** Persists the results of the run, when the caller supplies one. */
  evalSetResultsManager?: EvalSetResultsManager;
}

/** Supplies the eval service that scores an agent. */
export interface EvalRuntime {
  createEvalService(params: EvalServiceParams): BaseEvalService;
}

let installedRuntime: EvalRuntime | undefined;

/** Installs the runtime. Pass `undefined` to uninstall it. */
export function setEvalRuntime(runtime?: EvalRuntime): void {
  installedRuntime = runtime;
}

/**
 * Returns the installed runtime.
 *
 * @throws {Error} `MISSING_EVAL_DEPENDENCIES_MESSAGE` when none is installed.
 */
export function getEvalRuntime(): EvalRuntime {
  if (!installedRuntime) {
    throw new Error(MISSING_EVAL_DEPENDENCIES_MESSAGE);
  }
  return installedRuntime;
}
