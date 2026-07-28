/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {DEFAULT_LIVE_TIMEOUT_SECONDS} from './constants.js';
import {InvocationSchema} from './eval_case.js';
import {EvalMetricSchema} from './eval_metrics.js';
import {EvalCaseResult} from './eval_result.js';

/**
 * Default number of parallel inferences/evaluations to run during an Eval.
 */
const DEFAULT_PARALLELISM = 4;

/**
 * Contains configurations needed to run evaluations.
 */
export const EvaluateConfigSchema = z.object({
  /** The list of metrics to be used in Eval. */
  evalMetrics: z.array(EvalMetricSchema),
  /**
   * Number of parallel evaluations to run during an Eval. A larger value can
   * consume model quota faster, especially for model-as-a-judge metrics that
   * enforce per-minute or per-second SLAs.
   */
  parallelism: z.number().default(DEFAULT_PARALLELISM),
});

/**
 * Contains configurations needed to run evaluations.
 */
export type EvaluateConfig = z.infer<typeof EvaluateConfigSchema>;

/**
 * Contains configurations needed to run inferences.
 */
export const InferenceConfigSchema = z.object({
  /** Labels with user-defined metadata to break down billed charges. */
  labels: z.record(z.string(), z.string()).optional(),
  /**
   * Number of parallel inferences to run during an Eval. A larger value can
   * consume model (or tool) quota faster.
   */
  parallelism: z.number().default(DEFAULT_PARALLELISM),
  /**
   * Whether to use live (bidirectional streaming) mode for inference. This is
   * required for Live API models (e.g. `gemini-*-live-*`).
   */
  useLive: z.boolean().default(false),
  /**
   * Timeout in seconds for waiting for model turn completion in live mode.
   */
  liveTimeoutSeconds: z.number().default(DEFAULT_LIVE_TIMEOUT_SECONDS),
});

/**
 * Contains configurations needed to run inferences.
 */
export type InferenceConfig = z.infer<typeof InferenceConfigSchema>;

/**
 * Represents a request to perform inferences for the eval cases in an eval set.
 */
export const InferenceRequestSchema = z.object({
  /** The name of the app to which the eval cases belong. */
  appName: z.string(),
  /** ID of the eval set. */
  evalSetId: z.string(),
  /**
   * IDs of the eval cases for which inferences need to be generated. All ids
   * should belong to the eval set. If empty or unspecified, all eval cases in
   * the eval set are evaluated.
   */
  evalCaseIds: z.array(z.string()).optional(),
  /** The config to use for inferencing. */
  inferenceConfig: InferenceConfigSchema,
});

/**
 * Represents a request to perform inferences for the eval cases in an eval set.
 */
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;

/**
 * Status of the inference.
 *
 * Numeric values are preserved to match adk-python's serialized integer form.
 */
export enum InferenceStatus {
  UNKNOWN = 0,
  SUCCESS = 1,
  FAILURE = 2,
}

/**
 * Contains inference results for a single eval case.
 */
export const InferenceResultSchema = z.object({
  /** The name of the app to which the eval case belongs. */
  appName: z.string(),
  /** ID of the eval set. */
  evalSetId: z.string(),
  /** ID of the eval case for which inferences were generated. */
  evalCaseId: z.string(),
  /** Inferences obtained from the Agent for the eval case. */
  inferences: z.array(InvocationSchema).optional(),
  /** ID of the inference session. */
  sessionId: z.string().nullable(),
  /** Status of the inference. */
  status: z.enum(InferenceStatus).default(InferenceStatus.UNKNOWN),
  /** Error message if the inference failed. */
  errorMessage: z.string().optional(),
});

/**
 * Contains inference results for a single eval case.
 */
export type InferenceResult = z.infer<typeof InferenceResultSchema>;

/**
 * Represents a request to evaluate a set of inference results.
 */
export const EvaluateRequestSchema = z.object({
  /** A list of inferences that need to be evaluated. */
  inferenceResults: z.array(InferenceResultSchema),
  /** The config to use for evaluations. */
  evaluateConfig: EvaluateConfigSchema,
});

/**
 * Represents a request to evaluate a set of inference results.
 */
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;

/**
 * A service to run Evals for an ADK agent.
 */
export abstract class BaseEvalService {
  /**
   * Returns `InferenceResult`s obtained from the Agent as and when they are
   * available.
   *
   * @param inferenceRequest The request for generating inferences.
   */
  abstract performInference(
    inferenceRequest: InferenceRequest,
  ): AsyncGenerator<InferenceResult, void, void>;

  /**
   * Returns an `EvalCaseResult` for each item as and when it is available.
   *
   * @param evaluateRequest The request to perform metric evaluations on the
   *     inferences.
   */
  abstract evaluate(
    evaluateRequest: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult, void, void>;
}
