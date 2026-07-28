/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The result of evaluating a candidate on a batch of examples.
 *
 * The three arrays are index-aligned with the input batch.
 *
 * @typeParam O The type of a single captured output.
 * @typeParam T The type of a single captured trajectory.
 */
export interface EvaluationBatch<O = unknown, T = unknown> {
  /** The captured output for each example in the batch. */
  outputs: O[];

  /** The score for each example in the batch (higher is better). */
  scores: number[];

  /**
   * The captured trajectory for each example in the batch, if traces were
   * requested. `null` when traces were not captured.
   */
  trajectories?: T[] | null;
}

/**
 * The protocol a GEPA engine uses to evaluate and reflect on candidates.
 *
 * A candidate is a map from component name to component text (for the prompt
 * optimizer there is a single `agent_prompt` component).
 *
 * @typeParam D The type of a single example identifier in a batch.
 * @typeParam O The type of a single captured output.
 * @typeParam T The type of a single captured trajectory.
 */
export interface GepaAdapter<D = string, O = unknown, T = unknown> {
  /**
   * Evaluates a candidate on a batch of examples.
   *
   * @param batch The example identifiers to evaluate.
   * @param candidate The candidate component texts to evaluate.
   * @param captureTraces Whether to capture per-example trajectories.
   * @returns The index-aligned evaluation results for the batch.
   */
  evaluate(
    batch: D[],
    candidate: Record<string, string>,
    captureTraces?: boolean,
  ): Promise<EvaluationBatch<O, T>>;

  /**
   * Builds the reflective dataset used to propose improved component texts.
   *
   * @param candidate The candidate that produced `evalBatch`.
   * @param evalBatch The evaluation results (with captured trajectories).
   * @param componentsToUpdate The component names to build a dataset for.
   * @returns A map from component name to a list of reflection rows.
   */
  makeReflectiveDataset(
    candidate: Record<string, string>,
    evalBatch: EvaluationBatch<O, T>,
    componentsToUpdate: string[],
  ): Record<string, Array<Record<string, unknown>>>;

  /**
   * Optionally proposes new component texts from the reflective dataset.
   *
   * When omitted, the engine falls back to its default reflective proposer.
   *
   * @param candidate The current candidate component texts.
   * @param reflectiveDataset The reflective dataset for the components.
   * @param componentsToUpdate The component names to propose new texts for.
   * @returns A map from component name to the proposed new text.
   */
  proposeNewTexts?(
    candidate: Record<string, string>,
    reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
    componentsToUpdate: string[],
  ): Promise<Record<string, string>>;
}
