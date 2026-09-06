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
 * A unique symbol to identify ADK agent optimizer classes.
 * Defined once and shared by all AgentOptimizer instances.
 */
const AGENT_OPTIMIZER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.agentOptimizer',
);

/**
 * Type guard to check if an object is an instance of AgentOptimizer.
 * @param obj The object to check.
 * @returns True if the object is an instance of AgentOptimizer, false
 *     otherwise.
 */
export function isAgentOptimizer(
  obj: unknown,
): obj is AgentOptimizer<SamplingResult, AgentWithScores> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    AGENT_OPTIMIZER_SIGNATURE_SYMBOL in obj &&
    obj[AGENT_OPTIMIZER_SIGNATURE_SYMBOL] === true
  );
}

/** Parameters for {@link AgentOptimizer.optimize}. */
export interface OptimizeParams<SamplingResultT extends SamplingResult> {
  /** The initial agent to be optimized. */
  initialAgent: LlmAgent;

  /**
   * The interface used to get training and validation example UIDs, request
   * agent evaluations, and get the data useful for optimizing the agent.
   */
  sampler: Sampler<SamplingResultT>;
}

/** Base class for agent optimizers. */
export abstract class AgentOptimizer<
  SamplingResultT extends SamplingResult,
  AgentWithScoresT extends AgentWithScores,
> {
  /**
   * A unique symbol to identify ADK agent optimizer classes.
   */
  readonly [AGENT_OPTIMIZER_SIGNATURE_SYMBOL] = true;

  /**
   * Runs the optimizer.
   *
   * @param params The initial agent and the sampler that scores candidates.
   * @returns The final result of the optimization process, containing the
   *     optimized agent instances along with their scores on the validation
   *     examples and any optimization metadata.
   */
  abstract optimize(
    params: OptimizeParams<SamplingResultT>,
  ): Promise<OptimizerResult<AgentWithScoresT>>;
}
