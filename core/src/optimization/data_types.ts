/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmAgent} from '../agents/llm_agent.js';

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
