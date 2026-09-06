/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {evalModel, type EvalModel} from './common.js';
import {rubricModel, type Rubric} from './eval_rubrics.js';

/** The verdict for one metric, or for a whole eval case. */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/**
 * Metrics that ADK ships with.
 *
 * The string values are written into eval config files and eval results, so
 * they match adk-python exactly.
 */
export enum PrebuiltMetrics {
  TOOL_TRAJECTORY_AVG_SCORE = 'tool_trajectory_avg_score',
  RESPONSE_EVALUATION_SCORE = 'response_evaluation_score',
  RESPONSE_MATCH_SCORE = 'response_match_score',
  SAFETY_V1 = 'safety_v1',
  FINAL_RESPONSE_MATCH_V2 = 'final_response_match_v2',
  RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1 = 'rubric_based_final_response_quality_v1',
  HALLUCINATIONS_V1 = 'hallucinations_v1',
  RUBRIC_BASED_TOOL_USE_QUALITY_V1 = 'rubric_based_tool_use_quality_v1',
  PER_TURN_USER_SIMULATOR_QUALITY_V1 = 'per_turn_user_simulator_quality_v1',
  MULTI_TURN_TASK_SUCCESS_V1 = 'multi_turn_task_success_v1',
  MULTI_TURN_TRAJECTORY_QUALITY_V1 = 'multi_turn_trajectory_quality_v1',
  MULTI_TURN_TOOL_USE_QUALITY_V1 = 'multi_turn_tool_use_quality_v1',
  RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1 = 'rubric_based_multi_turn_trajectory_quality_v1',
}

/** The value a metric's score is compared against to decide pass from fail. */
export type Threshold = number;

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

const MIN_JUDGE_PARALLELISM_LIMIT = 1;

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

/** {@link JudgeModelOptions} with every default applied. */
export interface ResolvedJudgeModelOptions {
  judgeModel: string;
  judgeModelConfig?: GenerateContentConfig;
  numSamples: number;
  parallelismLimit: number;
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
  threshold: Threshold;

  /**
   * Whether to judge the intermediate text an agent emits before its tool
   * calls together with its final response. Defaults to false, which judges
   * the final response alone.
   */
  includeIntermediateResponsesInFinal?: boolean;
}

/** Criterion for a metric that asks a judge model to score a response. */
export interface LlmAsAJudgeCriterion extends BaseCriterion {
  /** Options for the judge model. */
  judgeModelOptions?: JudgeModelOptions;
}

/** Criterion for a metric that scores a response against rubrics. */
export interface RubricsBasedCriterion extends LlmAsAJudgeCriterion {
  /**
   * The rubrics the metric applies. Defaults to an empty list. A metric that
   * needs rubrics rejects a criterion that names none; a metric that does not
   * use rubrics ignores the field.
   */
  rubrics?: Rubric[];
}

/**
 * An {@link LlmAsAJudgeCriterion} that has been validated, so its judge model
 * options carry every default and a judge can read them off the criterion.
 */
export interface ParsedLlmAsAJudgeCriterion extends LlmAsAJudgeCriterion {
  judgeModelOptions: ResolvedJudgeModelOptions;
}

/**
 * A {@link RubricsBasedCriterion} that has been validated, so its judge model
 * options and its rubric list are both set.
 */
export interface ParsedRubricsBasedCriterion extends ParsedLlmAsAJudgeCriterion {
  rubrics: Rubric[];
}

/** Every criterion shape this metric's config can carry. */
export type EvalMetricCriterion =
  | BaseCriterion
  | LlmAsAJudgeCriterion
  | RubricsBasedCriterion;

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

const baseCriterionShape = {
  threshold: z.number(),
  includeIntermediateResponsesInFinal: z.boolean().default(false),
};

/**
 * A criterion keeps the keys its own shape does not name.
 *
 * adk-python declares `BaseCriterion` with `extra="allow"` rather than
 * inheriting `EvalBaseModel`, because an eval config holds one criterion
 * literal whose metric-specific fields must survive being read as a base
 * criterion.
 */
const CRITERION_OPTIONS = {extraKeys: 'allow'} as const;

/**
 * Validates a {@link JudgeModelOptions} payload.
 *
 * `judgeModelConfig` passes through by reference: it holds a `@google/genai`
 * object this schema does not describe, matching adk-python's
 * `arbitrary_types_allowed`.
 */
const judgeModelOptionsModel: EvalModel<ResolvedJudgeModelOptions> = evalModel(
  {
    judgeModel: z.string().default(DEFAULT_JUDGE_MODEL),
    judgeModelConfig: z.custom<GenerateContentConfig>().optional(),
    numSamples: z.number().int().default(DEFAULT_JUDGE_NUM_SAMPLES),
    parallelismLimit: z
      .number()
      .int()
      .min(MIN_JUDGE_PARALLELISM_LIMIT)
      .default(DEFAULT_JUDGE_PARALLELISM_LIMIT),
  },
  {name: 'JudgeModelOptions'},
);

const judgeModelOptionsField = judgeModelOptionsModel.schema.prefault({});

const llmAsAJudgeCriterionShape = {
  ...baseCriterionShape,
  judgeModelOptions: judgeModelOptionsField,
};

/** Validates a {@link RubricsBasedCriterion} payload. */
const rubricsBasedCriterionModel: EvalModel<ParsedRubricsBasedCriterion> =
  evalModel(
    {
      ...llmAsAJudgeCriterionShape,
      rubrics: z.array(rubricModel.schema).default(() => []),
    },
    {...CRITERION_OPTIONS, name: 'RubricsBasedCriterion'},
  );

/**
 * A function that validates a criterion read from a config file, and applies
 * its defaults.
 *
 * {@link LlmAsJudge} takes one of these so that it can name the criterion type
 * its metric expects when the criterion does not fit.
 */
export interface CriterionParser<CriterionT extends BaseCriterion> {
  (raw: unknown): CriterionT;

  /** The name of the criterion type, for error messages. */
  readonly criterionName: string;
}

/**
 * Validates a rubric-backed criterion payload.
 *
 * @throws {InputValidationError} When the payload is not a valid criterion, or
 *   one of its rubrics is invalid.
 */
export function parseRubricsBasedCriterion(
  raw: unknown,
): ParsedRubricsBasedCriterion {
  return rubricsBasedCriterionModel.parse(raw);
}
parseRubricsBasedCriterion.criterionName = 'RubricsBasedCriterion';

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
