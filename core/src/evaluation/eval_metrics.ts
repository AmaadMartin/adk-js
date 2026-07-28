/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

import {InvocationSchema} from './eval_case.js';
import {RubricSchema, RubricScoreSchema} from './eval_rubrics.js';

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
 * The name of a metric: either a free-form string or a {@link PrebuiltMetrics}.
 */
export type MetricName = string | PrebuiltMetrics;

/**
 * A numeric threshold used by a metric.
 */
export type Threshold = number;

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
 * The type of match between actual and expected tool call trajectories.
 *
 * Numeric values are preserved to match adk-python's serialized integer form.
 */
export enum MatchType {
  /** Requires a perfect match between the actual and expected tool calls. */
  EXACT = 0,
  /**
   * Requires the actual tool calls to be in the same order as expected, with
   * allowance for extra tool calls.
   */
  IN_ORDER = 1,
  /**
   * Requires the actual tool calls to include the expected ones in any order,
   * with allowance for extra tool calls.
   */
  ANY_ORDER = 2,
}

// Reproduces adk-python's `_coerce_match_type`: a `MatchType` value passes
// through; a string is normalized and mapped to a member; anything else passes
// through unchanged for the enum schema to reject.
const MatchTypeSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase().replace(/[-\s]/g, '_');
    const mapped = MatchType[normalized as keyof typeof MatchType];
    if (typeof mapped === 'number') {
      return mapped;
    }
  }
  return value;
}, z.enum(MatchType));

/**
 * Criterion used when evaluating an agent's tool trajectory against a reference.
 */
export const ToolTrajectoryCriterionSchema = BaseCriterionSchema.extend({
  /** The type of match between actual and expected tool call trajectories. */
  matchType: MatchTypeSchema.default(MatchType.EXACT),
}).loose();

/**
 * Criterion used when evaluating an agent's tool trajectory against a reference.
 */
export type ToolTrajectoryCriterion = z.infer<
  typeof ToolTrajectoryCriterionSchema
>;

/**
 * Criterion for LLM-backed user simulator evaluators.
 */
export const LlmBackedUserSimulatorCriterionSchema =
  LlmAsAJudgeCriterionSchema.extend({
    /** Stop signal validating the successful completion of a conversation. */
    stopSignal: z.string().default('</finished>'),
  }).loose();

/**
 * Criterion for LLM-backed user simulator evaluators.
 */
export type LlmBackedUserSimulatorCriterion = z.infer<
  typeof LlmBackedUserSimulatorCriterionSchema
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

/**
 * Additional details about a computed eval metric result.
 */
export const EvalMetricResultDetailsSchema = z
  .object({
    /** The scores obtained after applying the rubrics to the response. */
    rubricScores: z.array(RubricScoreSchema).optional(),
  })
  .strict();

/**
 * Additional details about a computed eval metric result.
 */
export type EvalMetricResultDetails = z.infer<
  typeof EvalMetricResultDetailsSchema
>;

/**
 * The actual computed score/value of a particular {@link EvalMetric}.
 */
export const EvalMetricResultSchema = EvalMetricSchema.extend({
  /**
   * Score obtained after evaluating the metric. Optional, as evaluation might
   * not have happened.
   */
  score: z.number().optional(),
  /** The status of this evaluation. */
  evalStatus: z.enum(EvalStatus),
  /** Additional details about the result. */
  details: EvalMetricResultDetailsSchema.default(() => ({})),
}).strict();

/**
 * The actual computed score/value of a particular {@link EvalMetric}.
 */
export type EvalMetricResult = z.infer<typeof EvalMetricResultSchema>;

/**
 * Eval metric results for a single invocation.
 */
export const EvalMetricResultPerInvocationSchema = z
  .object({
    /** The actual invocation, usually obtained by inferencing the agent. */
    actualInvocation: InvocationSchema,
    /** The expected (reference or golden) invocation. */
    expectedInvocation: InvocationSchema.optional(),
    /** Eval results for each applicable metric. */
    evalMetricResults: z.array(EvalMetricResultSchema).default(() => []),
  })
  .strict();

/**
 * Eval metric results for a single invocation.
 */
export type EvalMetricResultPerInvocation = z.infer<
  typeof EvalMetricResultPerInvocationSchema
>;

/**
 * Represents a range of numeric values, e.g. [0, 1] or (2, 3) or [-1, 6).
 */
export const IntervalSchema = z
  .object({
    /** The smaller end of the interval. */
    minValue: z.number(),
    /** Whether the interval is open on the min end (closed by default). */
    openAtMin: z.boolean().default(false),
    /** The larger end of the interval. */
    maxValue: z.number(),
    /** Whether the interval is open on the max end (closed by default). */
    openAtMax: z.boolean().default(false),
  })
  .strict();

/**
 * Represents a range of numeric values.
 */
export type Interval = z.infer<typeof IntervalSchema>;

/**
 * Information about the type of value a metric produces.
 */
export const MetricValueInfoSchema = z
  .object({
    /** The values represented by the metric are of type interval. */
    interval: IntervalSchema.optional(),
  })
  .strict();

/**
 * Information about the type of value a metric produces.
 */
export type MetricValueInfo = z.infer<typeof MetricValueInfoSchema>;

/**
 * Information about a metric used for evals.
 */
export const MetricInfoSchema = z
  .object({
    /** The name of the metric. */
    metricName: z.string(),
    /** A 2 to 3 line description of the metric. */
    description: z.string().default(''),
    /** Information on the nature of values supported by the metric. */
    metricValueInfo: MetricValueInfoSchema,
  })
  .strict();

/**
 * Information about a metric used for evals.
 */
export type MetricInfo = z.infer<typeof MetricInfoSchema>;

/**
 * Interface for providing {@link MetricInfo}.
 */
export interface MetricInfoProvider {
  /** Returns MetricInfo for a given metric. */
  getMetricInfo(): MetricInfo;
}
