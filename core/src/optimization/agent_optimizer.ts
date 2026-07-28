/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent as Agent} from '../agents/llm_agent.js';
import {
  AgentWithScores,
  OptimizerResult,
  SamplingResult,
} from './data_types.js';
import {Sampler} from './sampler.js';

/**
 * Base class for agent optimizers.
 *
 * @typeParam R The {@link SamplingResult} type produced by the sampler.
 * @typeParam A The {@link AgentWithScores} type produced by the optimizer.
 */
export abstract class AgentOptimizer<
  R extends SamplingResult,
  A extends AgentWithScores,
> {
  /**
   * Runs the optimizer.
   *
   * @param initialAgent The initial agent to be optimized.
   * @param sampler The interface used to get training and validation example
   *   UIDs, request agent evaluations, and get useful data for optimizing the
   *   agent.
   * @returns The final result of the optimization process, containing the
   *   optimized agent instances along with their corresponding scores on the
   *   validation examples and any optimization metadata.
   */
  abstract optimize(
    initialAgent: Agent,
    sampler: Sampler<R>,
  ): Promise<OptimizerResult<A>>;
}
