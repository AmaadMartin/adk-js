/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {evalModel, optionalField, type EvalModel} from './common.js';
import type {Rubric} from './eval_rubrics.js';

export type {Rubric, RubricContent} from './eval_rubrics.js';

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
   * repeatedly and the samples are aggregated. A judge-backed metric applies
   * its own default.
   */
  numSamples?: number;

  /**
   * The maximum number of parallel judge calls to execute. At least 1. A
   * judge-backed metric applies its own default.
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
export interface RubricsBasedCriterion extends BaseCriterion {
  /** Options for the judge model. */
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
  /** Options for the judge model. */
  judgeModelOptions?: JudgeModelOptions;

  /**
   * Whether intermediate natural language responses are scored as well.
   * Defaults to false, which scores the final response alone.
   */
  evaluateIntermediateNlResponses?: boolean;
}

/** Criterion for a metric backed by an LLM user simulator. */
export interface LlmBackedUserSimulatorCriterion extends LlmAsAJudgeCriterion {
  /**
   * The signal that marks a conversation complete. For the best results it
   * matches the one the user simulator emits. Defaults to `</finished>`.
   */
  stopSignal?: string;
}

/**
 * How actual tool calls are matched against the expected trajectory.
 *
 * The members carry their own names as values, where adk-python's `MatchType`
 * carries the integers 0, 1 and 2. adk-python reads a name, so a criterion
 * written here loads there; a criterion adk-python serialized carries an
 * integer this package does not resolve.
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
   * string spelling such as `'in order'`, `'IN-ORDER'` or `'in_order'`, which
   * the tool trajectory metric resolves to a member.
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

/** Validates an {@link Interval} payload. */
const intervalModel: EvalModel<Interval> = evalModel(
  {
    minValue: z.number(),
    openAtMin: z.boolean().default(false),
    maxValue: z.number(),
    openAtMax: z.boolean().default(false),
  },
  {name: 'Interval'},
);

/** Validates a {@link MetricValueInfo} payload. */
const metricValueInfoModel: EvalModel<MetricValueInfo> = evalModel(
  {interval: optionalField(intervalModel.schema)},
  {name: 'MetricValueInfo'},
);

/** Validates a {@link MetricInfo} payload. */
const metricInfoModel: EvalModel<MetricInfo> = evalModel(
  {
    metricName: z.string(),
    description: optionalField(z.string()),
    metricValueInfo: metricValueInfoModel.schema,
  },
  {name: 'MetricInfo'},
);

/**
 * Validates a metric info payload.
 *
 * @throws {InputValidationError} When the payload omits `metricName` or
 *   `metricValueInfo`.
 */
export function parseMetricInfo(raw: unknown): MetricInfo {
  return metricInfoModel.parse(raw);
}

const configCustomFunctionPaths = new WeakMap<EvalMetric, string>();

/**
 * Records the custom function path an eval config declared for this metric.
 *
 * The path is kept off the metric's own shape so a metric parsed from an
 * inbound payload cannot carry one: the public {@link EvalMetric.customFunctionPath}
 * field is settable by whoever built that payload, this is not. It is keyed by
 * the metric object rather than by metric name, so two apps in one process can
 * declare the same metric name and each still resolves its own function.
 */
export function setConfigCustomFunctionPath(
  evalMetric: EvalMetric,
  customFunctionPath: string,
): void {
  configCustomFunctionPaths.set(evalMetric, customFunctionPath);
}

/** Returns the path an eval config declared for this metric, if any. */
export function getConfigCustomFunctionPath(
  evalMetric: EvalMetric,
): string | undefined {
  return configCustomFunctionPaths.get(evalMetric);
}
