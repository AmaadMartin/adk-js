/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmAgent} from '../agents/llm_agent.js';

import type {
  AgentWithScores,
  OptimizerResult,
  SamplingResult,
} from './data_types.js';
import type {Sampler} from './sampler.js';

/**
 * Base interface for agent optimizers.
 */
export interface AgentOptimizer<
  TSamplingResult extends SamplingResult = SamplingResult,
  TAgentWithScores extends AgentWithScores = AgentWithScores,
> {
  /**
   * Runs the optimizer.
   *
   * @param initialAgent The initial agent to be optimized.
   * @param sampler The interface used to get training and validation example
   *     UIDs, request agent evaluations, and get useful data for optimizing
   *     the agent.
   * @return The final result of the optimization process, containing the
   *     optimized agent instances along with their corresponding scores on the
   *     validation examples.
   */
  optimize(
    initialAgent: LlmAgent,
    sampler: Sampler<TSamplingResult>,
  ): Promise<OptimizerResult<TAgentWithScores>>;
}
