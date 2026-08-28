/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation} from './eval_case.js';
import {EvalMetric} from './eval_metrics.js';
import {EvalCaseResult} from './eval_result.js';

/** Seconds to wait for a model turn to complete in live mode. */
const DEFAULT_LIVE_TIMEOUT_SECONDS = 300;

/** Inferences an eval runs at the same time. */
const DEFAULT_INFERENCE_PARALLELISM = 4;

/** Metric evaluations an eval runs at the same time. */
const DEFAULT_EVALUATE_PARALLELISM = 4;

/**
 * Configuration for the evaluation phase.
 */
export interface EvaluateConfig {
  /** The metrics to apply. */
  evalMetrics: EvalMetric[];

  /**
   * Number of evaluations to run at the same time.
   *
   * The ceiling is the quota of the judge model, not the number of cores: a
   * model enforces a per-minute or per-second limit, and a large value spends
   * that quota quickly.
   */
  parallelism: number;
}

/**
 * Configuration for the inference phase.
 */
export interface InferenceConfig {
  /** User-defined metadata that breaks down the billed charges. */
  labels?: Record<string, string>;

  /**
   * Number of inferences to run at the same time.
   *
   * The ceiling is the quota of the model and of the tools the agent calls,
   * not the number of cores. A large value can exhaust the model quota or
   * overwhelm a tool.
   */
  parallelism: number;

  /**
   * Whether to run inference in live, that is bidirectional streaming, mode.
   * Live API models such as `gemini-*-live-*` require it.
   */
  useLive: boolean;

  /** Seconds to wait for a model turn to complete in live mode. */
  liveTimeoutSeconds: number;
}

/**
 * A request to run inference over the eval cases of an eval set.
 */
export interface InferenceRequest {
  /** The name of the app that the eval case belongs to. */
  appName: string;

  /** Id of the eval set. */
  evalSetId: string;

  /**
   * Ids of the eval cases to run. Every id should belong to the eval set. A
   * service runs every case in the set when this list is empty or absent, and
   * skips an id that matches no case instead of reporting an error.
   */
  evalCaseIds?: string[];

  /** The config to use for inference. */
  inferenceConfig: InferenceConfig;
}

/**
 * The outcome of running inference for one eval case.
 *
 * The numeric values match adk-python's `InferenceStatus`, because they appear
 * in serialized inference results.
 */
export enum InferenceStatus {
  UNKNOWN = 0,
  SUCCESS = 1,
  FAILURE = 2,
}

/**
 * The inference results for a single eval case.
 *
 * This record is serializable on purpose. A caller saves a run and scores it
 * later against different metrics, without paying for inference again, so the
 * JSON shape is part of the contract.
 */
export interface InferenceResult {
  /** The name of the app that the eval case belongs to. */
  appName: string;

  /** Id of the eval set. */
  evalSetId: string;

  /** Id of the eval case that this result covers. */
  evalCaseId: string;

  /** The invocations obtained from the agent for the eval case. */
  inferences?: Invocation[];

  /** Id of the inference session, absent when the run used no session. */
  sessionId?: string;

  /** Status of the inference. */
  status: InferenceStatus;

  /** Error message, set when the inference failed. */
  errorMessage?: string;
}

/**
 * A request to score inference results.
 */
export interface EvaluateRequest {
  /** The inference results to evaluate. */
  inferenceResults: InferenceResult[];

  /** The config to use for evaluation. */
  evaluateConfig: EvaluateConfig;
}

/**
 * A service that runs evals for an ADK agent.
 *
 * The two phases are separate calls because they have different costs.
 * `performInference` runs the agent and calls the model; `evaluate` scores
 * results that already exist. A caller can run the first once and the second
 * many times.
 *
 * Both methods stream. An implementation yields each result as soon as it has
 * it, rather than collecting every result and yielding at the end, so a long
 * eval set reports its first case in seconds.
 */
export interface BaseEvalService {
  /**
   * Yields an `InferenceResult` for each eval case, as it becomes available.
   *
   * Results arrive in completion order, which is not the order of the eval
   * cases in the request. An implementation reports a failed inference as a
   * result with `InferenceStatus.FAILURE` and an `errorMessage`, and keeps
   * going; it does not reject the generator.
   *
   * @param inferenceRequest The request to run inference.
   */
  performInference(
    inferenceRequest: InferenceRequest,
  ): AsyncGenerator<InferenceResult, void, void>;

  /**
   * Yields an `EvalCaseResult` for each inference result, as it becomes
   * available.
   *
   * Results arrive in completion order. A metric that could not score a case
   * reports `EvalStatus.NOT_EVALUATED` rather than raising.
   *
   * @param evaluateRequest The request to score the inference results.
   */
  evaluate(
    evaluateRequest: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult, void, void>;
}

/**
 * Creates an inference config, filling in the adk-python defaults.
 *
 * @param params The values to override.
 * @returns The inference config.
 */
export function createInferenceConfig(
  params: Partial<InferenceConfig> = {},
): InferenceConfig {
  return {
    ...params,
    parallelism: params.parallelism ?? DEFAULT_INFERENCE_PARALLELISM,
    useLive: params.useLive ?? false,
    liveTimeoutSeconds:
      params.liveTimeoutSeconds ?? DEFAULT_LIVE_TIMEOUT_SECONDS,
  };
}

/**
 * Creates an evaluate config, filling in the adk-python defaults.
 *
 * @param params The metrics to apply, and the values to override.
 * @returns The evaluate config.
 */
export function createEvaluateConfig(
  params: Partial<EvaluateConfig> & {evalMetrics: EvalMetric[]},
): EvaluateConfig {
  return {
    ...params,
    parallelism: params.parallelism ?? DEFAULT_EVALUATE_PARALLELISM,
  };
}
