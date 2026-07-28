/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent as Agent} from '../agents/llm_agent.js';
import {SamplingResult} from './data_types.js';

/** The example set a candidate agent is evaluated against. */
export type ExampleSet = 'train' | 'validation';

/**
 * Base class for agent optimizers to sample and score candidate agents.
 *
 * The developer must implement this interface for their evaluation service to
 * work with an optimizer. The optimizer calls {@link Sampler.sampleAndScore} to
 * get evaluation results for a candidate agent on a batch of examples.
 *
 * @typeParam R The concrete {@link SamplingResult} type this sampler returns.
 */
export abstract class Sampler<R extends SamplingResult = SamplingResult> {
  /** Returns the UIDs of examples to use for training the agent. */
  abstract getTrainExampleIds(): string[];

  /** Returns the UIDs of examples to use for validating the optimized agent. */
  abstract getValidationExampleIds(): string[];

  /**
   * Evaluates the candidate agent on the batch of examples.
   *
   * @param candidate The candidate agent to be evaluated.
   * @param exampleSet The set of examples to evaluate the candidate agent on.
   *   Defaults to `'validation'`.
   * @param batch The UIDs of examples to evaluate the candidate agent on. If
   *   not provided, all examples from the chosen set should be used.
   * @param captureFullEvalData If false, it is enough to only calculate the
   *   scores for each example. If true, this method should also capture all
   *   other data required for optimizing the agent (e.g., outputs,
   *   trajectories, and tool calls). Defaults to false.
   * @returns The evaluation results, containing the scores for each example
   *   and (if requested) other data required for optimization.
   */
  abstract sampleAndScore(
    candidate: Agent,
    exampleSet?: ExampleSet,
    batch?: string[],
    captureFullEvalData?: boolean,
  ): Promise<R>;
}
