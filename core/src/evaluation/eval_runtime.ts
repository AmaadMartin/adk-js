/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The contract `AgentEvaluator` needs from the code that runs an agent and
 * scores its metrics.
 *
 * `local_eval_service.ts` is not in this package yet, so it is loaded at call
 * time rather than imported: a static import of a file that does not exist
 * would not compile, and the rest of this directory works without it. Once
 * that module lands, this becomes a plain import of `createEvalService` and
 * the lazy load goes away.
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
 * The module that will provide the service. Held in a constant rather than
 * written as a literal, so that the compiler does not resolve a file that is
 * not there yet.
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

/** Builds the service that runs an eval set and scores its metrics. */
export type CreateEvalService = (
  options: CreateEvalServiceOptions,
) => BaseEvalService;

/**
 * Loads the local eval service.
 *
 * @throws If the local eval service is not part of this build. It is not
 *   today, so every call throws; `AgentEvaluator` is held out of the package's
 *   public exports until it lands.
 */
export async function loadCreateEvalService(): Promise<CreateEvalService> {
  let loadError: unknown;
  const runtimeModule: unknown = await import(LOCAL_EVAL_SERVICE_MODULE).catch(
    (err: unknown) => {
      loadError = err;
      return undefined;
    },
  );
  if (
    !isRecord(runtimeModule) ||
    typeof runtimeModule['createEvalService'] !== 'function'
  ) {
    throw new Error(MISSING_EVAL_DEPENDENCIES_MESSAGE, {cause: loadError});
  }
  return runtimeModule['createEvalService'] as CreateEvalService;
}
