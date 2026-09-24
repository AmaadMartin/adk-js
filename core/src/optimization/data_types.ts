/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmAgent} from '../agents/llm_agent.js';

/**
 * Base shape for evaluation results of a candidate agent on a batch of
 * examples.
 */
export interface SamplingResult {
  /**
   * A map from example UID to the agent's overall score on that example
   * (higher is better).
   */
  scores: Record<string, number>;
}

/** Evaluation result providing per-example unstructured evaluation data. */
export interface UnstructuredSamplingResult extends SamplingResult {
  /**
   * A map from example UID to JSON-serializable evaluation data useful for
   * agent optimization. Recommended contents include inputs, trajectories and
   * metrics. Must be provided if the optimizer requested it.
   */
  data?: Record<string, Record<string, unknown>>;
}

/**
 * An optimized agent with its scores.
 *
 * Optimizers may return custom metrics by extending this interface.
 */
export interface AgentWithScores {
  /** The optimized agent. */
  optimizedAgent: LlmAgent;

  /** The overall score of the optimized agent. */
  overallScore?: number;
}

/** Base shape for optimizer final results. */
export interface OptimizerResult<
  AgentWithScoresT extends AgentWithScores = AgentWithScores,
> {
  /**
   * Optimized agents that cannot be considered strictly better than one
   * another (a Pareto front), along with their scores.
   */
  optimizedAgents: AgentWithScoresT[];
}
