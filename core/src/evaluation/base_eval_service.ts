/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation} from './eval_case.js';
import {EvalMetric} from './eval_metrics.js';
import {EvalCaseResult} from './eval_result.js';

/** How the agent is run to produce the inferences an eval scores. */
export interface InferenceConfig {
  /**
   * Whether to run in live (bidirectional streaming) mode, which Live API
   * models require.
   */
  useLive: boolean;

  /**
   * Seconds to wait for a model turn to complete in live mode. Defaults to
   * `DEFAULT_LIVE_TIMEOUT_SECONDS`.
   */
  liveTimeoutSeconds?: number;
}

/** A request to run the agent over the eval cases of one eval set. */
export interface InferenceRequest {
  appName: string;

  evalSetId: string;

  /**
   * The eval cases to run. When absent, every case in the eval set is run.
   */
  evalCaseIds?: string[];

  inferenceConfig: InferenceConfig;
}

/** Whether an inference succeeded. */
export enum InferenceStatus {
  UNKNOWN = 0,
  SUCCESS = 1,
  FAILURE = 2,
}

/** The inferences obtained for a single eval case. */
export interface InferenceResult {
  appName: string;

  evalSetId: string;

  evalCaseId: string;

  /** The invocations the agent produced. Absent when the run failed. */
  inferences?: Invocation[];

  /** The session the inferences were produced in. */
  sessionId?: string;

  status: InferenceStatus;

  errorMessage?: string;
}

/** Which metrics to score. */
export interface EvaluateConfig {
  evalMetrics: EvalMetric[];
}

/** A request to score inferences against a set of metrics. */
export interface EvaluateRequest {
  inferenceResults: InferenceResult[];

  evaluateConfig: EvaluateConfig;
}

/** Runs evals for an ADK agent. */
export interface BaseEvalService {
  /** Yields each inference result as it becomes available. */
  performInference(
    inferenceRequest: InferenceRequest,
  ): AsyncGenerator<InferenceResult>;

  /** Yields each eval case result as it becomes available. */
  evaluate(evaluateRequest: EvaluateRequest): AsyncGenerator<EvalCaseResult>;
}
