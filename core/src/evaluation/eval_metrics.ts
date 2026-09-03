/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {evalModel, optionalField, type EvalModel} from './common.js';
import {rubricModel, rubricScoreModel} from './eval_rubrics.js';

export type {Rubric, RubricContent, RubricScore} from './eval_rubrics.js';

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

/** The name of a metric: a {@link PrebuiltMetrics} member or a custom name. */
export type MetricName = string | PrebuiltMetrics;

/** The value a metric's score is compared against to decide pass from fail. */
export type Threshold = number;

/** The judge model a metric prompts when the criterion names no other. */
const DEFAULT_JUDGE_MODEL = 'gemini-2.5-flash';

const DEFAULT_NUM_SAMPLES = 5;

const MIN_PARALLELISM_LIMIT = 1;

const DEFAULT_PARALLELISM_LIMIT = 1;

const DEFAULT_STOP_SIGNAL = '</finished>';

/** Options for an eval metric's judge model. */
export interface JudgeModelOptions {
  /** The judge model to use for evaluation. It can be a model name. */
  judgeModel: string;

  /** The configuration for the judge model. */
  judgeModelConfig?: GenerateContentConfig;

  /**
   * How many times to sample the model for one invocation evaluation.
   *
   * Models carry a degree of unreliability, so the same data is sampled
   * repeatedly and the samples are aggregated. adk-python found 5 to be a good
   * default.
   */
  numSamples: number;

  /** The maximum number of parallel judge calls to execute. At least 1. */
  parallelismLimit: number;
}

/**
 * Validates a {@link JudgeModelOptions} payload.
 *
 * `judgeModelConfig` passes through by reference: it holds a `@google/genai`
 * object this schema does not describe, matching adk-python's
 * `arbitrary_types_allowed`.
 */
export const judgeModelOptionsModel: EvalModel<JudgeModelOptions> = evalModel(
  {
    judgeModel: z.string().default(DEFAULT_JUDGE_MODEL),
    judgeModelConfig: z.custom<GenerateContentConfig>().optional(),
    numSamples: z.number().int().default(DEFAULT_NUM_SAMPLES),
    parallelismLimit: z
      .number()
      .int()
      .min(MIN_PARALLELISM_LIMIT)
      .default(DEFAULT_PARALLELISM_LIMIT),
  },
  {name: 'JudgeModelOptions'},
);

/**
 * Validates a judge model options payload and applies every default.
 *
 * @throws {InputValidationError} When the payload names an option a judge
 *   cannot honour, such as a `parallelismLimit` below 1.
 */
export function parseJudgeModelOptions(raw: unknown): JudgeModelOptions {
  return judgeModelOptionsModel.parse(raw);
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
   * Whether to evaluate the full agent response, including the intermediate
   * natural language text emitted before tool calls, in addition to the final
   * response. When false only the final response text reaches the judge. This
   * is useful for agents that emit text both before and after tool calls
   * within one invocation.
   */
  includeIntermediateResponsesInFinal: boolean;
}

/** Criterion for a metric that asks a judge model to score a response. */
export interface LlmAsAJudgeCriterion extends BaseCriterion {
  /** Options for the judge model. */
  judgeModelOptions: JudgeModelOptions;
}

/** Criterion for a metric that scores a response against rubrics. */
export interface RubricsBasedCriterion extends BaseCriterion {
  /** Options for the judge model. */
  judgeModelOptions: JudgeModelOptions;

  /**
   * The rubrics the metric applies. A metric that does not use rubrics ignores
   * this; a metric that does, such as
   * {@link PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1}, fails
   * without it.
   */
  rubrics: Rubric[];
}

/** Criterion for scoring an agent's response for hallucinations. */
export interface HallucinationsCriterion extends BaseCriterion {
  /** Options for the judge model. */
  judgeModelOptions: JudgeModelOptions;

  /**
   * Whether the intermediate natural language responses are scored for
   * hallucinations too. When false only the final response is.
   */
  evaluateIntermediateNlResponses: boolean;
}

/** Criterion for a metric backed by an LLM user simulator. */
export interface LlmBackedUserSimulatorCriterion extends LlmAsAJudgeCriterion {
  /**
   * The signal that marks a conversation complete. For the best results it
   * matches the one the user simulator emits.
   */
  stopSignal: string;
}

/**
 * How actual tool calls are matched against the expected trajectory.
 *
 * The member names are the names of adk-python's `MatchType`, which its
 * criterion accepts as strings under `match_type`. That is where this enum
 * crosses the language boundary.
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
   * Defaults to {@link ToolTrajectoryMatchType.EXACT}. A config file writes a
   * string spelling such as `'in order'`, `'IN-ORDER'` or `'in_order'`, which
   * {@link normalizeToolTrajectoryMatchType} resolves.
   */
  matchType: ToolTrajectoryMatchType;

  /** When true only tool names are compared and arguments are ignored. */
  ignoreArgs: boolean;
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

const matchTypeSchema = z
  .unknown()
  .optional()
  .transform((value, ctx) => {
    const matchType = normalizeToolTrajectoryMatchType(value);
    if (matchType === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid tool trajectory match type: ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
    return matchType;
  });

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

/** Validates a {@link BaseCriterion} payload. */
export const baseCriterionModel: EvalModel<BaseCriterion> = evalModel(
  baseCriterionShape,
  {...CRITERION_OPTIONS, name: 'BaseCriterion'},
);

const judgeModelOptionsField = judgeModelOptionsModel.schema.prefault({});

const llmAsAJudgeCriterionShape = {
  ...baseCriterionShape,
  judgeModelOptions: judgeModelOptionsField,
};

/** Validates an {@link LlmAsAJudgeCriterion} payload. */
export const llmAsAJudgeCriterionModel: EvalModel<LlmAsAJudgeCriterion> =
  evalModel(llmAsAJudgeCriterionShape, {
    ...CRITERION_OPTIONS,
    name: 'LlmAsAJudgeCriterion',
  });

/** Validates a {@link RubricsBasedCriterion} payload. */
export const rubricsBasedCriterionModel: EvalModel<RubricsBasedCriterion> =
  evalModel(
    {
      ...llmAsAJudgeCriterionShape,
      rubrics: z.array(rubricModel.schema).default(() => []),
    },
    {...CRITERION_OPTIONS, name: 'RubricsBasedCriterion'},
  );

/** Validates a {@link HallucinationsCriterion} payload. */
export const hallucinationsCriterionModel: EvalModel<HallucinationsCriterion> =
  evalModel(
    {
      ...llmAsAJudgeCriterionShape,
      evaluateIntermediateNlResponses: z.boolean().default(false),
    },
    {...CRITERION_OPTIONS, name: 'HallucinationsCriterion'},
  );

/** Validates an {@link LlmBackedUserSimulatorCriterion} payload. */
export const llmBackedUserSimulatorCriterionModel: EvalModel<LlmBackedUserSimulatorCriterion> =
  evalModel(
    {
      ...llmAsAJudgeCriterionShape,
      stopSignal: z.string().default(DEFAULT_STOP_SIGNAL),
    },
    {...CRITERION_OPTIONS, name: 'LlmBackedUserSimulatorCriterion'},
  );

/** Validates a {@link ToolTrajectoryCriterion} payload. */
export const toolTrajectoryCriterionModel: EvalModel<ToolTrajectoryCriterion> =
  evalModel(
    {
      ...baseCriterionShape,
      matchType: matchTypeSchema,
      ignoreArgs: z.boolean().default(false),
    },
    {...CRITERION_OPTIONS, name: 'ToolTrajectoryCriterion'},
  );

/**
 * Validates a base criterion payload, keeping any metric-specific keys.
 *
 * @throws {InputValidationError} When the payload names no threshold.
 */
export function parseBaseCriterion(raw: unknown): BaseCriterion {
  return baseCriterionModel.parse(raw);
}

/**
 * Validates a judge-backed criterion payload.
 *
 * @throws {InputValidationError} When the payload is not a valid criterion.
 */
export function parseLlmAsAJudgeCriterion(raw: unknown): LlmAsAJudgeCriterion {
  return llmAsAJudgeCriterionModel.parse(raw);
}

/**
 * Validates a rubric-backed criterion payload.
 *
 * @throws {InputValidationError} When the payload is not a valid criterion, or
 *   one of its rubrics is invalid.
 */
export function parseRubricsBasedCriterion(
  raw: unknown,
): RubricsBasedCriterion {
  return rubricsBasedCriterionModel.parse(raw);
}

/**
 * Validates a hallucinations criterion payload.
 *
 * @throws {InputValidationError} When the payload is not a valid criterion.
 */
export function parseHallucinationsCriterion(
  raw: unknown,
): HallucinationsCriterion {
  return hallucinationsCriterionModel.parse(raw);
}

/**
 * Validates a user simulator criterion payload.
 *
 * @throws {InputValidationError} When the payload is not a valid criterion.
 */
export function parseLlmBackedUserSimulatorCriterion(
  raw: unknown,
): LlmBackedUserSimulatorCriterion {
  return llmBackedUserSimulatorCriterionModel.parse(raw);
}

/**
 * Validates a tool trajectory criterion payload.
 *
 * @throws {InputValidationError} When the payload names a match type
 *   {@link normalizeToolTrajectoryMatchType} does not resolve.
 */
export function parseToolTrajectoryCriterion(
  raw: unknown,
): ToolTrajectoryCriterion {
  return toolTrajectoryCriterionModel.parse(raw);
}

/** A metric used to evaluate one aspect of an eval case. */
export interface EvalMetric {
  /** The name of the metric. */
  metricName: string;

  /**
   * @deprecated Use {@link criterion} instead. Each metric decides how to
   *   interpret this threshold.
   */
  threshold?: Threshold;

  /** The evaluation criterion the metric uses. */
  criterion?: BaseCriterion;

  /** Path to the scoring function, when this is a custom metric. */
  customFunctionPath?: string;
}

const evalMetricShape = {
  metricName: z.string(),
  threshold: optionalField(z.number()),
  criterion: optionalField(baseCriterionModel.schema),
  customFunctionPath: optionalField(z.string()),
};

/** Validates an {@link EvalMetric} payload. */
export const evalMetricModel: EvalModel<EvalMetric> = evalModel(
  evalMetricShape,
  {name: 'EvalMetric'},
);

/**
 * Validates an eval metric payload.
 *
 * The result never carries a config-declared custom function path, whatever
 * the payload named. See {@link setConfigCustomFunctionPath}.
 *
 * @throws {InputValidationError} When the payload names an unrecognized key or
 *   omits `metricName`.
 */
export function parseEvalMetric(raw: unknown): EvalMetric {
  return evalMetricModel.parse(raw);
}

/** Supporting detail a metric reports alongside its score. */
export interface EvalMetricResultDetails {
  /** The scores obtained by applying the rubrics to the agent's response. */
  rubricScores?: RubricScore[];
}

/** Validates an {@link EvalMetricResultDetails} payload. */
export const evalMetricResultDetailsModel: EvalModel<EvalMetricResultDetails> =
  evalModel(
    {rubricScores: optionalField(z.array(rubricScoreModel.schema))},
    {name: 'EvalMetricResultDetails'},
  );

/** The computed value of an {@link EvalMetric}. */
export interface EvalMetricResult extends EvalMetric {
  /** Absent when the metric was not evaluated. */
  score?: number;

  /** The status of this evaluation. */
  evalStatus: EvalStatus;

  /** Supporting evidence for the score. */
  details: EvalMetricResultDetails;
}

/** Validates an {@link EvalMetricResult} payload. */
export const evalMetricResultModel: EvalModel<EvalMetricResult> = evalModel(
  {
    ...evalMetricShape,
    score: optionalField(z.number()),
    evalStatus: z.enum(EvalStatus),
    details: evalMetricResultDetailsModel.schema.prefault({}),
  },
  {name: 'EvalMetricResult'},
);

/**
 * Validates an eval metric result payload.
 *
 * @throws {InputValidationError} When the payload omits `evalStatus`, or names
 *   an unrecognized key.
 */
export function parseEvalMetricResult(raw: unknown): EvalMetricResult {
  return evalMetricResultModel.parse(raw);
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

/** A range of numeric values, e.g. `[0, 1]`, `(2, 3)` or `[-1, 6)`. */
export interface Interval {
  /** The smaller end of the interval. */
  minValue: number;

  /** The interval is open at the min end. When false it is closed. */
  openAtMin: boolean;

  /** The larger end of the interval. */
  maxValue: number;

  /** The interval is open at the max end. When false it is closed. */
  openAtMax: boolean;
}

/** Validates an {@link Interval} payload. */
export const intervalModel: EvalModel<Interval> = evalModel(
  {
    minValue: z.number(),
    openAtMin: z.boolean().default(false),
    maxValue: z.number(),
    openAtMax: z.boolean().default(false),
  },
  {name: 'Interval'},
);

/** The nature of the values a metric reports. */
export interface MetricValueInfo {
  /** Present when the metric reports values drawn from an interval. */
  interval?: Interval;
}

/** Validates a {@link MetricValueInfo} payload. */
export const metricValueInfoModel: EvalModel<MetricValueInfo> = evalModel(
  {interval: optionalField(intervalModel.schema)},
  {name: 'MetricValueInfo'},
);

/** What the eval framework knows about a metric. */
export interface MetricInfo {
  /** The name of the metric. */
  metricName: string;

  /** A two to three line description of the metric. */
  description?: string;

  /** The nature of the values the metric supports. */
  metricValueInfo: MetricValueInfo;
}

/** Validates a {@link MetricInfo} payload. */
export const metricInfoModel: EvalModel<MetricInfo> = evalModel(
  {
    metricName: z.string(),
    description: optionalField(z.string()),
    metricValueInfo: metricValueInfoModel.schema,
  },
  {name: 'MetricInfo'},
);

/**
 * Validates an interval payload.
 *
 * @throws {InputValidationError} When the payload omits an end of the interval.
 */
export function parseInterval(raw: unknown): Interval {
  return intervalModel.parse(raw);
}

/**
 * Validates a metric value info payload.
 *
 * @throws {InputValidationError} When the payload names an invalid interval.
 */
export function parseMetricValueInfo(raw: unknown): MetricValueInfo {
  return metricValueInfoModel.parse(raw);
}

/**
 * Validates a metric info payload.
 *
 * @throws {InputValidationError} When the payload omits `metricName` or
 *   `metricValueInfo`.
 */
export function parseMetricInfo(raw: unknown): MetricInfo {
  return metricInfoModel.parse(raw);
}

/** Implemented by anything that describes a metric to the eval framework. */
export interface MetricInfoProvider {
  /** Returns the {@link MetricInfo} for the metric this provider owns. */
  getMetricInfo(): MetricInfo;
}
