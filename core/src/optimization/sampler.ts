/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmAgent} from '../agents/llm_agent.js';

import type {SamplingResult} from './data_types.js';

/** The set of examples to evaluate a candidate agent on. */
export type ExampleSet = 'train' | 'validation';

/**
 * The parameters for {@link Sampler.sampleAndScore}.
 */
export interface SampleAndScoreParams {
  /** The candidate agent to be evaluated. */
  candidate: LlmAgent;

  /** The set of examples to evaluate the candidate agent on. */
  exampleSet: ExampleSet;

  /**
   * UIDs of the examples to evaluate the candidate agent on. When omitted, all
   * examples from the chosen set are used.
   */
  batch?: string[];

  /**
   * When false, it is enough to only calculate the scores for each example.
   * When true, the implementation must also capture all other data required
   * for optimizing the agent (e.g. outputs, trajectories, and tool calls).
   */
  captureFullEvalData: boolean;
}

/**
 * Base interface for agent optimizers to sample and score candidate agents.
 *
 * The developer must implement this interface for their evaluation service to
 * work with the optimizer. The optimizer calls `sampleAndScore` to get
 * evaluation results for the candidate agent on the batch of examples.
 */
export interface Sampler<T extends SamplingResult = SamplingResult> {
  /** Returns the UIDs of examples to use for training the agent. */
  getTrainExampleIds(): string[];

  /** Returns the UIDs of examples to use for validating the optimized agent. */
  getValidationExampleIds(): string[];

  /**
   * Evaluates the candidate agent on the batch of examples.
   *
   * @param params The candidate agent, the example set, the batch of example
   *     UIDs, and whether full evaluation data is required.
   * @return The evaluation results, containing the scores for each example and
   *     (if requested) other data required for optimization.
   */
  sampleAndScore(params: SampleAndScoreParams): Promise<T>;
}
