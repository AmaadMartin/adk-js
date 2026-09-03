/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

import {InputValidationError} from '../errors/input_validation_error.js';
import {Rubric} from './eval_rubrics.js';

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
}

/** The model that grades an invocation, and how often it is asked. */
export interface JudgeModelOptions {
  /** The judge model to use for evaluation. Defaults to `gemini-2.5-flash`. */
  judgeModel: string;

  /** The configuration for the judge model. */
  judgeModelConfig?: GenerateContentConfig;

  /**
   * How many times the model is sampled per invocation. Models carry some
   * unreliability, so the same data is sampled repeatedly and the samples are
   * aggregated. Defaults to 5, which adk-python found to be a good default.
   */
  numSamples: number;

  /** The maximum number of judge calls in flight at once. Defaults to 1. */
  parallelismLimit: number;
}

/** Criterion for a metric that is graded by a judge model. */
export interface LlmAsAJudgeCriterion extends BaseCriterion {
  judgeModelOptions: JudgeModelOptions;
}

/** Criterion for a metric that grades against rubrics. */
export interface RubricsBasedCriterion extends BaseCriterion {
  judgeModelOptions: JudgeModelOptions;

  /**
   * The rubrics the metric applies. Metrics that do not use rubrics ignore
   * this field.
   */
  rubrics: Rubric[];
}

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
  criterion?: BaseCriterion | LlmAsAJudgeCriterion | RubricsBasedCriterion;
}

/** The judge model an eval metric uses when its criterion names none. */
export const DEFAULT_JUDGE_MODEL = 'gemini-2.5-flash';

const JUDGE_MODEL_OPTIONS_SCHEMA = z.strictObject({
  judgeModel: z.string().default(DEFAULT_JUDGE_MODEL),
  judgeModelConfig: z.custom<GenerateContentConfig>().optional(),
  numSamples: z.number().int().default(5),
  parallelismLimit: z.number().int().min(1).default(1),
});

const RUBRIC_SCHEMA = z.strictObject({
  rubricId: z.string(),
  rubricContent: z.strictObject({textProperty: z.string().optional()}),
  description: z.string().optional(),
  type: z.string().optional(),
});

// Loose rather than strict: adk-python's `BaseCriterion` sets `extra="allow"`,
// so a criterion read from a config file keeps the fields a concrete metric
// adds to it. `JudgeModelOptions` and `Rubric` above extend `EvalBaseModel`,
// which sets `extra="forbid"`, so those reject an unknown key.
const BASE_CRITERION_SHAPE = {
  threshold: z.number(),
  judgeModelOptions: JUDGE_MODEL_OPTIONS_SCHEMA.prefault({}),
};

const LLM_AS_A_JUDGE_CRITERION_SCHEMA = z.looseObject(BASE_CRITERION_SHAPE);

const RUBRICS_BASED_CRITERION_SCHEMA = z.looseObject({
  ...BASE_CRITERION_SHAPE,
  rubrics: z.array(RUBRIC_SCHEMA).default([]),
});

/**
 * Validates a criterion read from a config file, and applies its defaults.
 *
 * {@link LlmAsJudge} takes one of these so that it can report the criterion
 * type its metric expects.
 */
export interface CriterionParser<CriterionT extends BaseCriterion> {
  (criterion: unknown): CriterionT;

  /** The name of the criterion type, for error messages. */
  readonly criterionName: string;
}

function parseWithSchema<SchemaT extends z.ZodType>(
  schema: SchemaT,
  criterion: unknown,
  criterionName: string,
): z.output<SchemaT> {
  const result = schema.safeParse(criterion);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid ${criterionName}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Parses a criterion for a metric that is graded by a judge model.
 *
 * @throws {InputValidationError} When the value is not a valid criterion.
 */
export function parseLlmAsAJudgeCriterion(
  criterion: unknown,
): LlmAsAJudgeCriterion {
  return parseWithSchema(
    LLM_AS_A_JUDGE_CRITERION_SCHEMA,
    criterion,
    parseLlmAsAJudgeCriterion.criterionName,
  );
}
parseLlmAsAJudgeCriterion.criterionName = 'LlmAsAJudgeCriterion';

/**
 * Parses a criterion for a metric that grades against rubrics.
 *
 * @throws {InputValidationError} When the value is not a valid criterion.
 */
export function parseRubricsBasedCriterion(
  criterion: unknown,
): RubricsBasedCriterion {
  return parseWithSchema(
    RUBRICS_BASED_CRITERION_SCHEMA,
    criterion,
    parseRubricsBasedCriterion.criterionName,
  );
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
