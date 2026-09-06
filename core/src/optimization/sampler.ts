/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmAgent} from '../agents/llm_agent.js';
import type {SamplingResult} from './data_types.js';

/**
 * A unique symbol to identify ADK sampler classes.
 * Defined once and shared by all Sampler instances.
 */
const SAMPLER_SIGNATURE_SYMBOL = Symbol.for('google.adk.sampler');

/**
 * Type guard to check if an object is an instance of Sampler.
 * @param obj The object to check.
 * @returns True if the object is an instance of Sampler, false otherwise.
 */
export function isSampler(obj: unknown): obj is Sampler<SamplingResult> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    SAMPLER_SIGNATURE_SYMBOL in obj &&
    obj[SAMPLER_SIGNATURE_SYMBOL] === true
  );
}

/** Which set of examples a candidate agent is scored against. */
export type ExampleSet = 'train' | 'validation';

/** Parameters for {@link Sampler.sampleAndScore}. */
export interface SampleAndScoreParams {
  /** The candidate agent to be evaluated. */
  candidate: LlmAgent;

  /**
   * The set of examples to evaluate the candidate agent on. Defaults to
   * `'validation'` when omitted.
   */
  exampleSet?: ExampleSet;

  /**
   * UIDs of the examples to evaluate the candidate agent on. When omitted, all
   * examples from the chosen set are used.
   */
  batch?: string[];

  /**
   * When false, only the per-example scores need to be calculated. When true,
   * the implementation should also capture the other data required to optimize
   * the agent (outputs, trajectories and tool calls). Defaults to false.
   */
  captureFullEvalData?: boolean;
}

/**
 * Base class for agent optimizers to sample and score candidate agents.
 *
 * A developer implements this interface so their evaluation service works with
 * an optimizer. The optimizer calls {@link Sampler.sampleAndScore} to get
 * evaluation results for a candidate agent on a batch of examples.
 */
export abstract class Sampler<
  SamplingResultT extends SamplingResult = SamplingResult,
> {
  /**
   * A unique symbol to identify ADK sampler classes.
   */
  readonly [SAMPLER_SIGNATURE_SYMBOL] = true;

  /** Returns the UIDs of the examples to use for training the agent. */
  abstract getTrainExampleIds(): string[];

  /**
   * Returns the UIDs of the examples to use for validating the optimized
   * agent.
   */
  abstract getValidationExampleIds(): string[];

  /**
   * Evaluates the candidate agent on the batch of examples.
   *
   * @param params The candidate agent, the example set, the batch of example
   *     UIDs, and whether to capture the full evaluation data.
   * @returns The evaluation results, containing the score for each example and
   *     (if requested) the other data required for optimization.
   */
  abstract sampleAndScore(
    params: SampleAndScoreParams,
  ): Promise<SamplingResultT>;
}
