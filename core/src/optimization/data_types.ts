/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {isLlmAgent, type LlmAgent} from '../agents/llm_agent.js';
import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * Evaluation result of a candidate agent on a batch of examples.
 */
export interface SamplingResult {
  /**
   * A map from example UID to the agent's overall score on that example
   * (higher is better).
   */
  scores: Record<string, number>;
}

/**
 * Evaluation result providing per-example unstructured evaluation data.
 */
export interface UnstructuredSamplingResult extends SamplingResult {
  /**
   * A map from example UID to JSON-serializable evaluation data useful for
   * agent optimization. Recommended contents include inputs, trajectories and
   * metrics. A sampler provides it when the optimizer asks for it.
   */
  data?: Record<string, Record<string, unknown>>;
}

/**
 * An optimized agent with its scores.
 *
 * An optimizer may use `overallScore`, and may return custom metrics by
 * extending this interface.
 */
export interface AgentWithScores {
  /** The optimized agent. */
  optimizedAgent: LlmAgent;

  /** The overall score of the optimized agent. */
  overallScore?: number;
}

/**
 * Final result of an optimization run.
 */
export interface OptimizerResult<T extends AgentWithScores = AgentWithScores> {
  /**
   * A list of optimized agents which cannot be considered strictly better than
   * one another (see https://en.wikipedia.org/wiki/Pareto_front), with scores.
   */
  optimizedAgents: T[];
}

const SCORES_ERROR = 'scores must map each example UID to a number.';
const DATA_ERROR =
  'data must map each example UID to an object of evaluation data.';
const AGENT_ERROR = 'optimizedAgent must be an LlmAgent.';
const OVERALL_SCORE_ERROR = 'overallScore must be a number.';
const AGENTS_ERROR = 'optimizedAgents must be an array of AgentWithScores.';

/**
 * Reads an optional field the way adk-python writes it.
 *
 * Python serializes an unset `Optional` field as `null`, so both `null` and an
 * absent key must read back as `undefined`.
 */
function optional<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

const samplingResultSchema = z.looseObject({
  scores: z.record(z.string(), z.number({error: SCORES_ERROR}), {
    error: SCORES_ERROR,
  }),
});

const unstructuredSamplingResultSchema = samplingResultSchema.extend({
  data: optional(
    z.record(
      z.string(),
      z.record(z.string(), z.unknown(), {error: DATA_ERROR}),
      {error: DATA_ERROR},
    ),
  ),
});

const agentWithScoresSchema = z.looseObject({
  optimizedAgent: z.custom<LlmAgent>(isLlmAgent, {error: AGENT_ERROR}),
  overallScore: optional(z.number({error: OVERALL_SCORE_ERROR})),
});

const optimizerResultSchema = z.looseObject({
  optimizedAgents: z.array(agentWithScoresSchema, {error: AGENTS_ERROR}),
});

/**
 * Validates a value against a schema, reporting the first issue.
 *
 * @param schema The schema to validate against.
 * @param value The value to validate.
 * @returns The validated value.
 * @throws InputValidationError If the value does not match the schema.
 */
function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InputValidationError(parsed.error.issues[0].message);
  }
  return parsed.data;
}

/**
 * Validates a sampling result that arrives as `unknown`.
 *
 * The compiler already guarantees the shape of a result built in TypeScript.
 * This is the boundary check for one it never saw: a result restored from
 * persisted JSON, or returned by a caller-supplied sampler.
 *
 * An unrecognized key survives, so a subtype's extra fields are not deleted.
 *
 * @param value The value to validate.
 * @returns The validated sampling result.
 * @throws InputValidationError If `scores` is missing, or does not map every
 *   key to a number.
 */
export function parseSamplingResult(value: unknown): SamplingResult {
  return parseOrThrow(samplingResultSchema, value);
}

/**
 * Validates an unstructured sampling result that arrives as `unknown`.
 *
 * An absent `data` and an explicit `null` both read back as `undefined`.
 *
 * @param value The value to validate.
 * @returns The validated sampling result.
 * @throws InputValidationError If `scores` is invalid, or `data` is present and
 *   is not a map of objects.
 */
export function parseUnstructuredSamplingResult(
  value: unknown,
): UnstructuredSamplingResult {
  return parseOrThrow(unstructuredSamplingResultSchema, value);
}

/**
 * Validates an optimized agent with its scores.
 *
 * `optimizedAgent` passes through by reference, so the caller gets back the
 * same agent it supplied. An absent `overallScore` and an explicit `null` both
 * read back as `undefined`.
 *
 * @param value The value to validate.
 * @returns The validated agent with its scores.
 * @throws InputValidationError If `optimizedAgent` is not an `LlmAgent`, or
 *   `overallScore` is present and is not a number.
 */
export function parseAgentWithScores(value: unknown): AgentWithScores {
  return parseOrThrow(agentWithScoresSchema, value);
}

/**
 * Validates an optimizer result, including every agent it carries.
 *
 * @param value The value to validate.
 * @returns The validated optimizer result.
 * @throws InputValidationError If `optimizedAgents` is missing, is not an
 *   array, or holds an element that is not a valid `AgentWithScores`.
 */
export function parseOptimizerResult(value: unknown): OptimizerResult {
  return parseOrThrow(optimizerResultSchema, value);
}
