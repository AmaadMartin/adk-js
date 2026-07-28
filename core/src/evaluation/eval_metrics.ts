/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Provided by evaluation sub-port #2 (data models); minimal stand-in pending
// merge. Faithful subset of adk-python `evaluation/eval_metrics.py`: only the
// status enum, prebuilt-metric names, judge-model options, criteria, and
// `EvalMetric` this sub-port depends on. The metric-result/metric-info models
// owned by #2 are intentionally omitted here.
// simplicity: minimal stand-in; the complete data model lands with sub-port #2.

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

import {RubricSchema} from './eval_rubrics.js';

/**
 * The status of an evaluation.
 *
 * Numeric values are preserved to match adk-python's serialized integer form.
 */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/**
 * The set of metrics that ship built-in with the eval framework.
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

/**
 * Options for an eval metric's judge model.
 */
export const JudgeModelOptionsSchema = z
  .object({
    /** The judge model to use for evaluation. */
    judgeModel: z.string().default('gemini-2.5-flash'),
    /** The configuration for the judge model. */
    judgeModelConfig: z.custom<GenerateContentConfig>().optional(),
    /**
     * The number of times to sample the model for each invocation evaluation.
     */
    numSamples: z.number().default(5),
  })
  .strict();

/**
 * Options for an eval metric's judge model.
 */
export type JudgeModelOptions = z.infer<typeof JudgeModelOptionsSchema>;

/**
 * Base criterion to use for an eval metric.
 *
 * Preserves unknown ("extra") properties round-trip (parity with adk-python's
 * `extra="allow"`), so subclass-specific fields survive when a criterion is
 * carried as its base type.
 */
export const BaseCriterionSchema = z
  .object({
    /** The threshold to be used by the metric. */
    threshold: z.number(),
    /**
     * Whether to evaluate the full agent response, including intermediate
     * natural language text, in addition to the final response.
     */
    includeIntermediateResponsesInFinal: z.boolean().default(false),
  })
  .loose();

/**
 * Base criterion to use for an eval metric.
 */
export type BaseCriterion = z.infer<typeof BaseCriterionSchema>;

/**
 * Criterion used with LLM-as-a-judge metrics.
 */
export const LlmAsAJudgeCriterionSchema = BaseCriterionSchema.extend({
  /** Options for the judge model. */
  judgeModelOptions: JudgeModelOptionsSchema.default(() =>
    JudgeModelOptionsSchema.parse({}),
  ),
}).loose();

/**
 * Criterion used with LLM-as-a-judge metrics.
 */
export type LlmAsAJudgeCriterion = z.infer<typeof LlmAsAJudgeCriterionSchema>;

/**
 * Criterion used with rubric-based metrics.
 */
export const RubricsBasedCriterionSchema = BaseCriterionSchema.extend({
  /** Options for the judge model. */
  judgeModelOptions: JudgeModelOptionsSchema.default(() =>
    JudgeModelOptionsSchema.parse({}),
  ),
  /** Rubrics to be used by the metric. */
  rubrics: z.array(RubricSchema).default(() => []),
}).loose();

/**
 * Criterion used with rubric-based metrics.
 */
export type RubricsBasedCriterion = z.infer<typeof RubricsBasedCriterionSchema>;

/**
 * Criterion used when evaluating an agent's response for hallucinations.
 */
export const HallucinationsCriterionSchema = BaseCriterionSchema.extend({
  /** Options for the judge model. */
  judgeModelOptions: JudgeModelOptionsSchema.default(() =>
    JudgeModelOptionsSchema.parse({}),
  ),
  /**
   * Whether intermediate NL responses should be evaluated for hallucinations.
   */
  evaluateIntermediateNlResponses: z.boolean().default(false),
}).loose();

/**
 * Criterion used when evaluating an agent's response for hallucinations.
 */
export type HallucinationsCriterion = z.infer<
  typeof HallucinationsCriterionSchema
>;

/**
 * A metric used to evaluate a particular aspect of an eval case.
 */
export const EvalMetricSchema = z
  .object({
    /** The name of the metric. */
    metricName: z.string(),
    /**
     * A threshold value. Deprecated in favor of `criterion`; each metric
     * decides how to interpret this threshold.
     */
    threshold: z.number().optional(),
    /** Evaluation criterion used by the metric. */
    criterion: BaseCriterionSchema.optional(),
    /** Path to a custom function, if this is a custom metric. */
    customFunctionPath: z.string().optional(),
  })
  .strict();

/**
 * A metric used to evaluate a particular aspect of an eval case.
 */
export type EvalMetric = z.infer<typeof EvalMetricSchema>;
