/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent as Agent} from '../agents/llm_agent.js';

/**
 * Base class for evaluation results of a candidate agent on a batch of
 * examples.
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
   * agent optimization. Recommended contents include inputs, trajectories,
   * and metrics. Must be provided if requested by the optimizer.
   */
  data?: Record<string, Record<string, unknown>>;
}

/**
 * An optimized agent together with its scores.
 *
 * Optimizers may use the {@link AgentWithScores.overallScore} field and can
 * return custom metrics by extending this interface.
 */
export interface AgentWithScores {
  /** The optimized agent. */
  optimizedAgent: Agent;

  /** The overall score of the optimized agent. */
  overallScore?: number;
}

/**
 * Base class for optimizer final results.
 *
 * @typeParam A The concrete {@link AgentWithScores} type produced by the
 *   optimizer.
 */
export interface OptimizerResult<A extends AgentWithScores = AgentWithScores> {
  /**
   * A list of optimized agents which cannot be considered strictly better than
   * one another (see https://en.wikipedia.org/wiki/Pareto_front), along with
   * their scores.
   */
  optimizedAgents: A[];
}
