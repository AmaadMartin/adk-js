/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {evalSchema, parseEval} from './common.js';

/** The verdict for one metric, or for a whole eval case. */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/** The model a judge-backed metric prompts when no other model is named. */
export const DEFAULT_JUDGE_MODEL = 'gemini-2.5-flash';

/**
 * How many times a judge-backed metric samples the model for one invocation.
 *
 * Models carry a degree of unreliability, so the same data is sampled
 * repeatedly and the samples are aggregated. Experimentation found 5 to be a
 * good default.
 */
export const DEFAULT_JUDGE_NUM_SAMPLES = 5;

/** How many judge calls a metric issues at once when it is not configured. */
export const DEFAULT_JUDGE_PARALLELISM_LIMIT = 1;

/** Options for an eval metric's judge model. Every field has a default. */
export interface JudgeModelOptions {
  /** The judge model to use for evaluation. It can be a model name. */
  judgeModel?: string;

  /** The configuration for the judge model. */
  judgeModelConfig?: GenerateContentConfig;

  /**
   * How many times to sample the model for one invocation evaluation.
   *
   * Models carry a degree of unreliability, so the same data is sampled
   * repeatedly and the samples are aggregated. Defaults to
   * {@link DEFAULT_JUDGE_NUM_SAMPLES}.
   */
  numSamples?: number;

  /**
   * The maximum number of parallel judge calls to execute. At least 1.
   * Defaults to {@link DEFAULT_JUDGE_PARALLELISM_LIMIT}.
   */
  parallelismLimit?: number;
}

/**
 * The criterion a metric is judged against.
 *
 * Metrics that need more than a threshold extend this. A criterion read from a
 * config file keeps the fields this interface does not name, so an evaluator
 * can read its own criterion out of a value validated as a base one.
 */
export interface BaseCriterion {
  /** The threshold to be used by the metric. */
  threshold: number;
}

/** Criterion for a metric that asks a judge model to score a response. */
export interface LlmAsAJudgeCriterion extends BaseCriterion {
  /** Options for the judge model. */
  judgeModelOptions?: JudgeModelOptions;
}

/** The signal a simulated user emits when the conversation is complete. */
export const DEFAULT_USER_SIMULATOR_STOP_SIGNAL = '</finished>';

/** Criterion for a metric backed by an LLM user simulator. */
export interface LlmBackedUserSimulatorCriterion extends LlmAsAJudgeCriterion {
  /**
   * The signal that marks a conversation complete. For the best results it
   * matches the one the user simulator emits. Defaults to
   * {@link DEFAULT_USER_SIMULATOR_STOP_SIGNAL}.
   */
  stopSignal?: string;
}

/** Every criterion shape an eval config can carry. */
export type EvalMetricCriterion =
  | BaseCriterion
  | LlmAsAJudgeCriterion
  | LlmBackedUserSimulatorCriterion;

/** A metric used to evaluate one aspect of an eval case. */
export interface EvalMetric {
  metricName: string;

  /**
   * @deprecated Use {@link criterion} instead.
   */
  threshold?: number;

  /**
   * The criterion the metric is judged against.
   *
   * The union names every concrete criterion a config can carry, so that a
   * criterion literal carrying metric-specific fields type-checks here.
   */
  criterion?: EvalMetricCriterion;

  /** Path to the scoring function, when this is a custom metric. */
  customFunctionPath?: string;
}

/**
 * Validates a {@link JudgeModelOptions} payload and applies every default.
 *
 * `judgeModelConfig` passes through by reference: it holds a `@google/genai`
 * object this schema does not describe, matching adk-python's
 * `arbitrary_types_allowed`.
 */
const judgeModelOptionsSchema = evalSchema(
  z.strictObject({
    judgeModel: z.string().default(DEFAULT_JUDGE_MODEL),
    judgeModelConfig: z.custom<GenerateContentConfig>().optional(),
    numSamples: z.number().int().default(DEFAULT_JUDGE_NUM_SAMPLES),
    parallelismLimit: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_JUDGE_PARALLELISM_LIMIT),
  }),
);

/**
 * Validates an {@link LlmBackedUserSimulatorCriterion} payload.
 *
 * A criterion keeps the keys its own shape does not name, so it is a loose
 * object: adk-python declares `BaseCriterion` with `extra="allow"`, because an
 * eval config holds one criterion literal whose metric-specific fields must
 * survive being read as a base criterion.
 */
const llmBackedUserSimulatorCriterionSchema = evalSchema(
  z.looseObject({
    threshold: z.number(),
    judgeModelOptions: judgeModelOptionsSchema.prefault({}),
    stopSignal: z.string().default(DEFAULT_USER_SIMULATOR_STOP_SIGNAL),
  }),
);

/**
 * An {@link LlmBackedUserSimulatorCriterion} with every default applied, as
 * {@link parseLlmBackedUserSimulatorCriterion} returns it.
 */
type ValidatedUserSimulatorCriterion = z.infer<
  typeof llmBackedUserSimulatorCriterionSchema
>;

/**
 * Validates a user simulator criterion payload.
 *
 * @throws {InputValidationError} When the payload is not a valid criterion.
 */
export function parseLlmBackedUserSimulatorCriterion(
  raw: unknown,
): ValidatedUserSimulatorCriterion {
  return parseEval(
    llmBackedUserSimulatorCriterionSchema,
    'LlmBackedUserSimulatorCriterion',
    raw,
  );
}

/**
 * Returns the threshold the metric is judged against.
 *
 * The criterion's threshold wins; the metric-level one is the deprecated
 * fallback.
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
