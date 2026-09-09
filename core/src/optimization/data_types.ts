/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmAgent} from '../agents/llm_agent.js';

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
   * agent optimization. Recommended contents include inputs, trajectories,
   * and metrics. Must be provided if requested by the optimizer through
   * {@link SampleAndScoreParams.captureFullEvalData}.
   */
  data?: Record<string, Record<string, unknown>>;
}

/**
 * An optimized agent with its scores.
 *
 * Optimizers may use the `overallScore` field and can return custom metrics by
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
   * one another (see https://en.wikipedia.org/wiki/Pareto_front), along with
   * scores.
   */
  optimizedAgents: T[];
}
