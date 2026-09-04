/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {evalModel, optionalField, type EvalModel} from './common.js';
import type {Invocation} from './eval_case.js';
import type {Rubric, RubricScore} from './eval_rubrics.js';
import {rubricModel, rubricScoreModel} from './eval_rubrics.js';

export type {Rubric, RubricContent, RubricScore} from './eval_rubrics.js';

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

/**
 * Validates a judge model options payload and applies every default.
 *
 * @throws {InputValidationError} When the payload names an option a judge
 *   cannot honour, such as a `parallelismLimit` below 1.
 */
export function parseJudgeModelOptions(
  raw: unknown,
): ResolvedJudgeModelOptions {
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
 * An {@link LlmBackedUserSimulatorCriterion} with every default applied, which
 * is the shape a validated criterion takes. A metric reading one never has to
 * re-apply a default.
 */
export interface ParsedLlmBackedUserSimulatorCriterion extends LlmBackedUserSimulatorCriterion {
  judgeModelOptions: ResolvedJudgeModelOptions;
  stopSignal: string;
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

/**
 * A {@link ToolTrajectoryCriterion} that has been validated, so its match type
 * is a member of the enum and its `ignoreArgs` is set.
 */
export interface ParsedToolTrajectoryCriterion extends ToolTrajectoryCriterion {
  matchType: ToolTrajectoryMatchType;
  ignoreArgs: boolean;
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

/**
 * An {@link EvalMetric} that an LLM-as-a-judge metric scores.
 *
 * It narrows the criterion, so that a criterion written inline keeps its
 * `judgeModelOptions` instead of failing the excess-property check.
 */
export interface LlmAsAJudgeMetric extends EvalMetric {
  criterion?: LlmAsAJudgeCriterion;
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
  /** Returns the {@link MetricInfo} for the metric this provider owns. */
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
const baseCriterionModel: EvalModel<BaseCriterion> = evalModel(
  baseCriterionShape,
  {...CRITERION_OPTIONS, name: 'BaseCriterion'},
);

const judgeModelOptionsField = judgeModelOptionsModel.schema.prefault({});

const llmAsAJudgeCriterionShape = {
  ...baseCriterionShape,
  judgeModelOptions: judgeModelOptionsField,
};

/** Validates an {@link LlmAsAJudgeCriterion} payload. */
const llmAsAJudgeCriterionModel: EvalModel<LlmAsAJudgeCriterion> = evalModel(
  llmAsAJudgeCriterionShape,
  {
    ...CRITERION_OPTIONS,
    name: 'LlmAsAJudgeCriterion',
  },
);

/** Validates a {@link RubricsBasedCriterion} payload. */
const rubricsBasedCriterionModel: EvalModel<RubricsBasedCriterion> = evalModel(
  {
    ...llmAsAJudgeCriterionShape,
    rubrics: z.array(rubricModel.schema).default(() => []),
  },
  {...CRITERION_OPTIONS, name: 'RubricsBasedCriterion'},
);

/** Validates a {@link HallucinationsCriterion} payload. */
const hallucinationsCriterionModel: EvalModel<HallucinationsCriterion> =
  evalModel(
    {
      ...llmAsAJudgeCriterionShape,
      evaluateIntermediateNlResponses: z.boolean().default(false),
    },
    {...CRITERION_OPTIONS, name: 'HallucinationsCriterion'},
  );

/** Validates an {@link LlmBackedUserSimulatorCriterion} payload. */
const llmBackedUserSimulatorCriterionModel: EvalModel<ParsedLlmBackedUserSimulatorCriterion> =
  evalModel(
    {
      ...llmAsAJudgeCriterionShape,
      stopSignal: z.string().default(DEFAULT_USER_SIMULATOR_STOP_SIGNAL),
    },
    {...CRITERION_OPTIONS, name: 'LlmBackedUserSimulatorCriterion'},
  );

/** Validates a {@link ToolTrajectoryCriterion} payload. */
const toolTrajectoryCriterionModel: EvalModel<ParsedToolTrajectoryCriterion> =
  evalModel(
    {
      ...baseCriterionShape,
      matchType: matchTypeSchema,
      ignoreArgs: z.boolean().default(false),
    },
    {...CRITERION_OPTIONS, name: 'ToolTrajectoryCriterion'},
  );

/**
 * A function that validates a criterion read from a config file, and applies
 * its defaults.
 *
 * {@link LlmAsJudge} takes one of these so that it can name the criterion type
 * its metric expects when the criterion does not fit. It is the callable form
 * of {@link CriterionType}, which an evaluator class declares instead.
 */
export interface CriterionParser<CriterionT extends BaseCriterion> {
  (raw: unknown): CriterionT;

  /** The name of the criterion type, for error messages. */
  readonly criterionName: string;
}

/**
 * Validates a base criterion payload, keeping any metric-specific keys.
 *
 * @throws {InputValidationError} When the payload names no threshold.
 */
export function parseBaseCriterion(raw: unknown): BaseCriterion {
  return baseCriterionModel.parse(raw);
}
parseBaseCriterion.criterionName = 'BaseCriterion';

/**
 * Validates a judge-backed criterion payload.
 *
 * @throws {InputValidationError} When the payload is not a valid criterion.
 */
export function parseLlmAsAJudgeCriterion(raw: unknown): LlmAsAJudgeCriterion {
  return llmAsAJudgeCriterionModel.parse(raw);
}
parseLlmAsAJudgeCriterion.criterionName = 'LlmAsAJudgeCriterion';

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
parseRubricsBasedCriterion.criterionName = 'RubricsBasedCriterion';

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
 * Validates a user simulator criterion payload, applying every default.
 *
 * @throws {InputValidationError} When the payload is not a valid criterion.
 */
export function parseLlmBackedUserSimulatorCriterion(
  raw: unknown,
): ParsedLlmBackedUserSimulatorCriterion {
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
): ParsedToolTrajectoryCriterion {
  return toolTrajectoryCriterionModel.parse(raw);
}

const evalMetricShape = {
  metricName: z.string(),
  threshold: optionalField(z.number()),
  criterion: optionalField(baseCriterionModel.schema),
  customFunctionPath: optionalField(z.string()),
};

/** Validates an {@link EvalMetric} payload. */
const evalMetricModel: EvalModel<EvalMetric> = evalModel(evalMetricShape, {
  name: 'EvalMetric',
});

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

/** Validates an {@link EvalMetricResultDetails} payload. */
const evalMetricResultDetailsModel: EvalModel<EvalMetricResultDetails> =
  evalModel(
    {rubricScores: optionalField(z.array(rubricScoreModel.schema))},
    {name: 'EvalMetricResultDetails'},
  );

/** Validates an {@link EvalMetricResult} payload. */
const evalMetricResultModel: EvalModel<EvalMetricResult> = evalModel(
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
 *   `metricValueInfo`, or carries a key the shape does not declare.
 */
export function parseMetricInfo(raw: unknown): MetricInfo {
  return metricInfoModel.parse(raw);
}
