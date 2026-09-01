/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seam between `AgentEvaluator` and the code that actually runs an
 * agent and scores metrics.
 *
 * adk-python imports `LocalEvalService` and the metric evaluator registry
 * inside `try/except ModuleNotFoundError` at call time, so that
 * `agent_evaluator` stays importable without the `google-adk[eval]` extra.
 * This module is the same idea: the local eval service is resolved lazily, and
 * everything else in the evaluation directory works whether or not it
 * resolves.
 */

import {BaseAgent} from '../agents/base_agent.js';
import {App} from '../apps/app.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {BaseEvalService} from './base_eval_service.js';
import {MISSING_EVAL_DEPENDENCIES_MESSAGE} from './constants.js';
import {EvalConfig} from './eval_config.js';
import {isRecord} from './eval_json.js';
import {EvalSetResultsManager} from './eval_set_results_manager.js';
import {EvalSetsManager} from './eval_sets_manager.js';

/**
 * The module that provides the runtime. It is built as a specifier at call
 * time rather than written as a literal, because the module is optional: a
 * literal would make the compiler and the bundler treat it as required.
 */
const LOCAL_EVAL_SERVICE_MODULE = './local_eval_service.js';

/** What the eval service needs in order to run one eval set. */
export interface CreateEvalServiceOptions {
  /** The agent to evaluate, already narrowed to any selected sub-agent. */
  rootAgent: BaseAgent;

  /** Holds the eval set being run. */
  evalSetsManager: EvalSetsManager;

  /**
   * The config the run was started with.
   *
   * The runtime owns the metric evaluator registry, so it is also what forks
   * that registry and registers `evalConfig.customMetrics` into the fork. A
   * fork rather than a fresh registry, so evaluators the caller registered
   * globally stay resolvable while this run's custom metrics do not leak back
   * into the default. It reads `evalConfig.userSimulatorConfig` for the same
   * reason: the simulator subsystem is the runtime's, not this module's.
   */
  evalConfig: EvalConfig;

  /** Loads artifacts during the run. */
  artifactService?: BaseArtifactService;

  /** The app the agent belongs to, when the agent module exposes one. */
  app?: App;

  /** Persists the run's results as they are produced. */
  evalSetResultsManager?: EvalSetResultsManager;
}

/** The part of the eval runtime that `AgentEvaluator` reaches. */
export interface EvalRuntime {
  createEvalService(options: CreateEvalServiceOptions): BaseEvalService;
}

/** Returns true when the loaded module provides the runtime contract. */
export function isEvalRuntime(value: unknown): value is EvalRuntime {
  return isRecord(value) && typeof value['createEvalService'] === 'function';
}

/**
 * Loads the eval runtime.
 *
 * @throws If the local eval service is not part of this build, or does not
 *   export a `createEvalService`.
 */
export async function loadEvalRuntime(): Promise<EvalRuntime> {
  let loadError: unknown;
  const runtimeModule: unknown = await import(LOCAL_EVAL_SERVICE_MODULE).catch(
    (err: unknown) => {
      loadError = err;
      return undefined;
    },
  );
  if (!isEvalRuntime(runtimeModule)) {
    throw new Error(MISSING_EVAL_DEPENDENCIES_MESSAGE, {cause: loadError});
  }
  return runtimeModule;
}
