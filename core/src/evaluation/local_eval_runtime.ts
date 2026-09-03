/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseEvalService} from './base_eval_service.js';
import {EvalRuntime, EvalServiceParams} from './eval_runtime.js';
import {LocalEvalService} from './local_eval_service.js';

/**
 * Builds a {@link LocalEvalService} for the {@link EvalRuntime} seam, so that
 * `AgentEvaluator` can score an agent.
 *
 * Install it yourself with `setEvalRuntime(new LocalEvalRuntime())`. This
 * module installs nothing on import: the runtime is a process-wide singleton,
 * and a barrel import should not decide what a process runs its evals on.
 *
 * `EvalServiceParams.evalConfig` is not read. It carries `customMetrics`,
 * which needs an evaluator that resolves a scoring function from a module
 * path, and `userSimulatorConfig`, which needs the model-backed simulator.
 * Neither exists here yet. A custom metric configured anyway is not dropped
 * silently: `AgentEvaluator` reads the same config, passes the metric to
 * `evaluate`, the registry does not resolve it, and the run then reports that
 * metric as unmet.
 */
export class LocalEvalRuntime implements EvalRuntime {
  createEvalService(params: EvalServiceParams): BaseEvalService {
    return new LocalEvalService({
      rootAgent: params.rootAgent,
      app: params.app,
      evalSetsManager: params.evalSetsManager,
      artifactService: params.artifactService,
      evalSetResultsManager: params.evalSetResultsManager,
    });
  }
}
