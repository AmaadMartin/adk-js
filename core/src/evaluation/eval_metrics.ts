/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';
import type {Invocation} from './eval_case.js';
import type {Rubric, RubricScore} from './eval_rubrics.js';

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

  /** Defaults to {@link DEFAULT_JUDGE_NUM_SAMPLES}. */
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

function requireInteger(field: string, value: number): number {
  if (!Number.isInteger(value)) {
    throw new InputValidationError(
      `judgeModelOptions.${field} must be an integer, but got ${value}.`,
    );
  }
  return value;
}

/**
 * Applies the judge model defaults and rejects options a judge cannot honour.
 *
 * adk-python applies these defaults and this validation in the
 * `JudgeModelOptions` constructor. A TypeScript interface is erased at run
 * time, so a caller reads its options through this function instead.
 *
 * @throws {InputValidationError} When `numSamples` or `parallelismLimit` is
 *   not an integer, or `parallelismLimit` is below 1.
 */
export function resolveJudgeModelOptions(
  options?: JudgeModelOptions,
): ResolvedJudgeModelOptions {
  const parallelismLimit = requireInteger(
    'parallelismLimit',
    options?.parallelismLimit ?? DEFAULT_JUDGE_PARALLELISM_LIMIT,
  );
  if (parallelismLimit < MIN_JUDGE_PARALLELISM_LIMIT) {
    throw new InputValidationError(
      `judgeModelOptions.parallelismLimit must be at least ` +
        `${MIN_JUDGE_PARALLELISM_LIMIT}, but got ${parallelismLimit}.`,
    );
  }

  return {
    judgeModel: options?.judgeModel ?? DEFAULT_JUDGE_MODEL,
    judgeModelConfig: options?.judgeModelConfig,
    numSamples: requireInteger(
      'numSamples',
      options?.numSamples ?? DEFAULT_JUDGE_NUM_SAMPLES,
    ),
    parallelismLimit,
  };
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
   * Whether to judge the intermediate text an agent emits before its tool
   * calls together with its final response. Defaults to false, which judges
   * the final response alone.
   */
  includeIntermediateResponsesInFinal?: boolean;
}

/** Criterion for a metric that asks a judge model to score a response. */
export interface LlmAsAJudgeCriterion extends BaseCriterion {
  judgeModelOptions?: JudgeModelOptions;
}

/** Criterion for a metric that scores a response against rubrics. */
export interface RubricsBasedCriterion extends BaseCriterion {
  judgeModelOptions?: JudgeModelOptions;

  /**
   * The rubrics the metric applies. Defaults to an empty list. A metric that
   * needs rubrics rejects a criterion that names none; a metric that does not
   * use rubrics ignores the field.
   */
  rubrics?: Rubric[];
}

/** Criterion for scoring an agent response for hallucinations. */
export interface HallucinationsCriterion extends BaseCriterion {
  judgeModelOptions?: JudgeModelOptions;

  /**
   * Whether intermediate natural language responses are scored as well.
   * Defaults to false, which scores the final response alone.
   */
  evaluateIntermediateNlResponses?: boolean;
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

/**
 * How actual tool calls are matched against the expected trajectory.
 *
 * The members carry their own names as values, where adk-python's `MatchType`
 * carries the integers 0, 1 and 2. adk-python reads a name, so a criterion
 * written here loads there; a criterion adk-python serialized carries an
 * integer that {@link normalizeToolTrajectoryMatchType} does not resolve.
 */
export enum ToolTrajectoryMatchType {
  /** The actual calls equal the expected ones, none extra and none missing. */
  EXACT = 'EXACT',

  /**
   * Every expected call appears in the actual calls in the expected order.
   * Extra actual calls in between are tolerated.
   */
  IN_ORDER = 'IN_ORDER',

  /**
   * Every expected call appears in the actual calls in any order, respecting
   * multiplicity. Extra actual calls are tolerated.
   */
  ANY_ORDER = 'ANY_ORDER',
}

/** Criterion for scoring a tool trajectory against a reference one. */
export interface ToolTrajectoryCriterion extends BaseCriterion {
  /**
   * Defaults to {@link ToolTrajectoryMatchType.EXACT}. Accepts the enum, or a
   * string spelling such as `'in order'`, `'IN-ORDER'` or `'in_order'`: a raw
   * string from a config file becomes a member through
   * {@link normalizeToolTrajectoryMatchType}.
   */
  matchType?: ToolTrajectoryMatchType | string;

  /**
   * When true only tool names are compared and arguments are ignored.
   * Defaults to false.
   */
  ignoreArgs?: boolean;
}

/** Every criterion shape an eval config can carry. */
export type EvalMetricCriterion =
  | BaseCriterion
  | ToolTrajectoryCriterion
  | LlmAsAJudgeCriterion
  | RubricsBasedCriterion
  | HallucinationsCriterion
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

/** Supporting detail a metric reports alongside its score. */
export interface EvalMetricResultDetails {
  /** The scores obtained by applying the criterion's rubrics. */
  rubricScores?: RubricScore[];
}

/** The computed value of an {@link EvalMetric}. */
export interface EvalMetricResult extends EvalMetric {
  /** Undefined when the metric was not evaluated. */
  score?: number;

  evalStatus: EvalStatus;

  details?: EvalMetricResultDetails;
}

/** The metric results for a single invocation. */
export interface EvalMetricResultPerInvocation {
  /** The invocation obtained by inferencing the agent. */
  actualInvocation: Invocation;

  /** The reference invocation, when the eval case recorded one. */
  expectedInvocation?: Invocation;

  evalMetricResults: EvalMetricResult[];
}

/** A range of numeric values, e.g. `[0, 1]`, `(2, 3)` or `[-1, 6)`. */
export interface Interval {
  /** The smaller end of the interval. */
  minValue: number;

  /** The interval is open at the min end. Defaults to false (closed). */
  openAtMin?: boolean;

  /** The larger end of the interval. */
  maxValue: number;

  /** The interval is open at the max end. Defaults to false (closed). */
  openAtMax?: boolean;
}

/** The nature of the values a metric reports. */
export interface MetricValueInfo {
  /** Present when the metric reports values drawn from an interval. */
  interval?: Interval;
}

/** What the eval framework knows about a metric. */
export interface MetricInfo {
  metricName: string;

  /** A two to three line description of the metric. */
  description?: string;

  metricValueInfo: MetricValueInfo;
}

/** Implemented by anything that describes a metric to the eval framework. */
export interface MetricInfoProvider {
  getMetricInfo(): MetricInfo;
}

const MATCH_TYPES_BY_NAME = new Map<string, ToolTrajectoryMatchType>(
  Object.values(ToolTrajectoryMatchType).map((matchType) => [
    matchType,
    matchType,
  ]),
);

/**
 * Returns the match type a value names, or `undefined` when it names none.
 *
 * An absent value reads as {@link ToolTrajectoryMatchType.EXACT}, the field
 * default. A string is trimmed, upper-cased, and its dashes and spaces read
 * as underscores, so `'any order'` and `'ANY-ORDER'` both resolve.
 */
export function normalizeToolTrajectoryMatchType(
  value: unknown,
): ToolTrajectoryMatchType | undefined {
  if (value === undefined) {
    return ToolTrajectoryMatchType.EXACT;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  return MATCH_TYPES_BY_NAME.get(
    value.trim().toUpperCase().replace(/[- ]/g, '_'),
  );
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
