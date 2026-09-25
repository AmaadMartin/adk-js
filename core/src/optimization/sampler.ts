/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmAgent} from '../agents/llm_agent.js';

import type {SamplingResult} from './data_types.js';

/** The set of examples to evaluate a candidate agent on. */
export type ExampleSet = 'train' | 'validation';

/** Parameters for {@link Sampler.sampleAndScore}. */
export interface SampleAndScoreParams {
  /** The candidate agent to be evaluated. */
  candidate: LlmAgent;

  /**
   * The set of examples to evaluate the candidate agent on. Implementations
   * default this to {@link Sampler.VALIDATION_SET} when it is omitted.
   */
  exampleSet?: ExampleSet;

  /**
   * UIDs of the examples to evaluate the candidate agent on. When omitted, all
   * examples from the chosen set are used.
   */
  batch?: string[];

  /**
   * When false, it is enough to calculate the scores for each example. When
   * true, the implementation must also capture all other data required for
   * optimizing the agent (e.g. outputs, trajectories and tool calls).
   * Implementations default this to `false` when it is omitted.
   */
  captureFullEvalData?: boolean;
}

/**
 * Base class for agent optimizers to sample and score candidate agents.
 *
 * The developer must implement this interface for their evaluation service to
 * work with the optimizer. The optimizer calls {@link Sampler.sampleAndScore}
 * to get evaluation results for the candidate agent on the batch of examples.
 */
export abstract class Sampler<T extends SamplingResult = SamplingResult> {
  /** The example set used to train the agent. */
  static readonly TRAIN_SET = 'train';

  /** The example set used to validate the optimized agent. */
  static readonly VALIDATION_SET = 'validation';

  /** Returns the UIDs of examples to use for training the agent. */
  abstract getTrainExampleIds(): string[];

  /** Returns the UIDs of examples to use for validating the optimized agent. */
  abstract getValidationExampleIds(): string[];

  /**
   * Evaluates the candidate agent on the batch of examples.
   *
   * @returns The evaluation results, containing the scores for each example
   *   and, if requested, other data required for optimization.
   */
  abstract sampleAndScore(params: SampleAndScoreParams): Promise<T>;
}
