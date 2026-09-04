/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isLlmAgent, type LlmAgent} from '../agents/llm_agent.js';
import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * Evaluation result of a candidate agent on a batch of examples.
 *
 * A sampler may extend this interface to carry the extra data an optimizer
 * needs.
 */
export interface SamplingResult {
  /**
   * A map from example UID to the agent's overall score on that example
   * (higher is better).
   */
  scores: Record<string, number>;
}

/** Evaluation result that also carries per-example unstructured data. */
export interface UnstructuredSamplingResult extends SamplingResult {
  /**
   * A map from example UID to JSON-serializable evaluation data useful for
   * agent optimization. Recommended contents are inputs, trajectories and
   * metrics. A sampler must provide it when the optimizer asks for it.
   */
  data?: Record<string, Record<string, unknown>>;
}

/**
 * An optimized agent with its scores.
 *
 * An optimizer that reports custom metrics extends this interface and
 * parameterizes {@link OptimizerResult} on the subtype.
 */
export interface AgentWithScores {
  /** The optimized agent. */
  optimizedAgent: LlmAgent;

  /** The overall score of the optimized agent. */
  overallScore?: number;
}

/** Final result of an optimization run. */
export interface OptimizerResult<T extends AgentWithScores = AgentWithScores> {
  /**
   * Optimized agents that cannot be considered strictly better than one
   * another (see https://en.wikipedia.org/wiki/Pareto_front), with scores.
   */
  optimizedAgents: T[];
}

/**
 * Validates a {@link SamplingResult} and returns it.
 *
 * A sampler is caller-supplied code, so its result reaches the optimizer
 * unchecked by the compiler. This is the runtime boundary for it.
 *
 * @param params The sampling result to validate.
 * @returns The same object, unchanged.
 * @throws {InputValidationError} When `scores` is not a map of numbers.
 */
export function createSamplingResult(params: SamplingResult): SamplingResult {
  validateScores(params.scores);
  return params;
}

/**
 * Validates an {@link UnstructuredSamplingResult} and returns it.
 *
 * @param params The sampling result to validate.
 * @returns The same object, unchanged.
 * @throws {InputValidationError} When `scores` is not a map of numbers, or
 *   `data` is present and is not a map of objects.
 */
export function createUnstructuredSamplingResult(
  params: UnstructuredSamplingResult,
): UnstructuredSamplingResult {
  validateScores(params.scores);
  validateEvalData(params.data);
  return params;
}

/**
 * Validates an {@link AgentWithScores} and returns it.
 *
 * `optimizedAgent` passes through by reference: the caller gets back the same
 * agent instance it supplied.
 *
 * @param params The optimized agent and its scores.
 * @returns The same object, unchanged, including any extra fields a subtype
 *   adds.
 * @throws {InputValidationError} When `optimizedAgent` is not an
 *   {@link LlmAgent}, or `overallScore` is present and is not a number.
 */
export function createAgentWithScores(
  params: AgentWithScores,
): AgentWithScores {
  validateAgentWithScores(params);
  return params;
}

/**
 * Validates an {@link OptimizerResult} and returns it.
 *
 * @param params The optimization run result.
 * @returns The same object, unchanged.
 * @throws {InputValidationError} When `optimizedAgents` is not an array, or an
 *   element fails the {@link createAgentWithScores} checks.
 */
export function createOptimizerResult<T extends AgentWithScores>(
  params: OptimizerResult<T>,
): OptimizerResult<T> {
  if (!Array.isArray(params.optimizedAgents)) {
    throw new InputValidationError('optimizedAgents must be an array.');
  }
  for (const agent of params.optimizedAgents) {
    validateAgentWithScores(agent);
  }
  return params;
}

function validateScores(scores: unknown): void {
  if (!isRecord(scores)) {
    throw new InputValidationError(
      'scores must be an object mapping each example UID to a number.',
    );
  }
  for (const [uid, score] of Object.entries(scores)) {
    if (typeof score !== 'number') {
      throw new InputValidationError(`scores['${uid}'] must be a number.`);
    }
  }
}

function validateEvalData(data: unknown): void {
  if (data === undefined) {
    return;
  }
  if (!isRecord(data)) {
    throw new InputValidationError(
      'data must be an object mapping each example UID to an object of evaluation data.',
    );
  }
  for (const [uid, entry] of Object.entries(data)) {
    if (!isRecord(entry)) {
      throw new InputValidationError(
        `data['${uid}'] must be an object of evaluation data.`,
      );
    }
  }
}

function validateAgentWithScores(params: AgentWithScores): void {
  if (!isLlmAgent(params.optimizedAgent)) {
    throw new InputValidationError('optimizedAgent must be an LlmAgent.');
  }
  validateOverallScore(params.overallScore);
}

function validateOverallScore(overallScore: unknown): void {
  if (overallScore !== undefined && typeof overallScore !== 'number') {
    throw new InputValidationError('overallScore must be a number.');
  }
}

/** Narrows an unknown value to a plain (non-array) record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
