/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {evalModel, type EvalModel} from './common.js';

/** The verdict for one metric, or for a whole eval case. */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/** The threshold a metric is judged against. A score at or above it passes. */
export type Threshold = number;

/** The judge model a metric uses when its criterion names none. */
const DEFAULT_JUDGE_MODEL = 'gemini-2.5-flash';

/**
 * How many times a metric samples its judge for one invocation when its
 * criterion names no count.
 */
export const DEFAULT_JUDGE_NUM_SAMPLES = 5;

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
}

/** {@link JudgeModelOptions} with every default applied. */
export interface ResolvedJudgeModelOptions {
  judgeModel: string;
  judgeModelConfig?: GenerateContentConfig;
  numSamples: number;
}

/**
 * Validates a {@link JudgeModelOptions} payload and applies every default.
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
  },
  {name: 'JudgeModelOptions'},
);

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
 * A criterion keeps the keys its own shape does not name.
 *
 * adk-python declares `BaseCriterion` with `extra="allow"` rather than
 * inheriting `EvalBaseModel`, because an eval config holds one criterion
 * literal whose metric-specific fields must survive being read as a base
 * criterion.
 */
const CRITERION_OPTIONS = {extraKeys: 'allow'} as const;

/** Validates an {@link LlmBackedUserSimulatorCriterion} payload. */
const llmBackedUserSimulatorCriterionModel: EvalModel<ParsedLlmBackedUserSimulatorCriterion> =
  evalModel(
    {
      threshold: z.number(),
      includeIntermediateResponsesInFinal: z.boolean().default(false),
      judgeModelOptions: judgeModelOptionsModel.schema.prefault({}),
      stopSignal: z.string().default(DEFAULT_USER_SIMULATOR_STOP_SIGNAL),
    },
    {...CRITERION_OPTIONS, name: 'LlmBackedUserSimulatorCriterion'},
  );

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
