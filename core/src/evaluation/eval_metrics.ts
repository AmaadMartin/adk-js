/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';

/** The verdict for one metric, or for a whole eval case. */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/**
 * The criterion a metric is judged against.
 *
 * Metrics that need more than a threshold extend this, so a criterion read
 * from a config file can carry fields this interface does not name.
 */
export interface BaseCriterion {
  threshold: number;

  /**
   * Whether the judge reads the intermediate text an agent emitted before its
   * tool calls, along with the final response. Defaults to false, so only the
   * final response text is judged.
   */
  includeIntermediateResponsesInFinal?: boolean;
}

/** The judge model an LLM-as-a-judge metric uses when the criterion names none. */
export const DEFAULT_JUDGE_MODEL = 'gemini-2.5-flash';

/**
 * How many times an LLM-as-a-judge metric samples its judge per invocation.
 * Models are unreliable enough that adk-python settled on five samples.
 */
export const DEFAULT_JUDGE_NUM_SAMPLES = 5;

/** How many judge calls run at once. One call at a time, by default. */
export const DEFAULT_JUDGE_PARALLELISM_LIMIT = 1;

/** Options for an eval metric's judge model. */
export interface JudgeModelOptions {
  /** The name of the judge model. Defaults to {@link DEFAULT_JUDGE_MODEL}. */
  judgeModel?: string;

  /** The generation config the judge model is called with. */
  judgeModelConfig?: GenerateContentConfig;

  /**
   * How many samples the judge produces per invocation. Defaults to
   * {@link DEFAULT_JUDGE_NUM_SAMPLES}, and must be at least 1.
   */
  numSamples?: number;

  /**
   * How many judge calls run at once. Defaults to
   * {@link DEFAULT_JUDGE_PARALLELISM_LIMIT}, and must be at least 1.
   */
  parallelismLimit?: number;
}

/** The criterion an LLM-as-a-judge metric is judged against. */
export interface LlmAsAJudgeCriterion extends BaseCriterion {
  judgeModelOptions?: JudgeModelOptions;
}

/** A metric used to evaluate one aspect of an eval case. */
export interface EvalMetric {
  metricName: string;

  /**
   * @deprecated Use {@link criterion} instead.
   */
  threshold?: number;

  /** The criterion the metric is judged against. */
  criterion?: BaseCriterion;
}

/**
 * An {@link EvalMetric} that an LLM-as-a-judge metric scores.
 *
 * It narrows the criterion, so that a criterion written inline keeps its
 * `judgeModelOptions` instead of failing the excess-property check.
 */
export interface LlmAsAJudgeMetric extends EvalMetric {
  criterion?: LlmAsAJudgeCriterion;
}

/**
 * Returns the threshold configured for a metric.
 *
 * The criterion threshold wins over the metric-level one.
 *
 * @throws {InputValidationError} When the metric carries neither a criterion
 *   nor a threshold.
 */
export function getMetricThreshold(evalMetric: EvalMetric): number {
  if (evalMetric.criterion !== undefined) {
    return evalMetric.criterion.threshold;
  }
  if (evalMetric.threshold !== undefined) {
    return evalMetric.threshold;
  }

  throw new InputValidationError(
    `Evaluation metric '${evalMetric.metricName}' requires a threshold.`,
  );
}
