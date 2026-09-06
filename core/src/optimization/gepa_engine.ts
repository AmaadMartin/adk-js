/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The GEPA engine contract that {@link
 * ../optimization/gepa_root_agent_prompt_optimizer.GEPARootAgentPromptOptimizer}
 * drives.
 *
 * ADK ships one implementation, {@link DefaultGepaEngine}. A caller who wants
 * another search writes these types instead.
 */

/**
 * One GEPA reflection call. The prompt is the text the engine wants the
 * reflection model to answer, and the result is that model's reply.
 */
export type ReflectionLm = (prompt: string) => Promise<string>;

/** Per-example results for one candidate over one batch. */
export interface EvaluationBatch {
  /** One score per batch example, in batch order. Higher is better. */
  scores: number[];

  /** Absent unless the engine asked for traces. */
  trajectories?: Array<Record<string, unknown>>;
}

/** The bridge between a GEPA engine and the system being optimized. */
export interface GepaAdapter {
  /**
   * Scores one candidate over one batch of examples.
   *
   * @param batch The example UIDs to score the candidate on.
   * @param candidate A map from component name to that component's text.
   * @param captureTraces Whether the engine needs trajectories back.
   */
  evaluate(
    batch: string[],
    candidate: Record<string, string>,
    captureTraces?: boolean,
  ): Promise<EvaluationBatch>;

  /**
   * Turns an evaluated batch into the records the reflection model reads.
   *
   * @param candidate The candidate that produced `evalBatch`.
   * @param evalBatch The results of scoring that candidate.
   * @param componentsToUpdate The component names the engine wants rewritten.
   * @returns One record list per requested component.
   */
  makeReflectiveDataset(
    candidate: Record<string, string>,
    evalBatch: EvaluationBatch,
    componentsToUpdate: string[],
  ): Record<string, Array<Record<string, unknown>>>;

  /**
   * Rewrites the requested components.
   *
   * Optional: an engine falls back to its own proposer when an adapter does
   * not supply one.
   *
   * @param candidate The candidate holding each component's current text.
   * @param reflectiveDataset The records `makeReflectiveDataset` produced.
   * @param componentsToUpdate The component names the engine wants rewritten.
   * @returns The new text of each requested component.
   */
  proposeNewTexts?(
    candidate: Record<string, string>,
    reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
    componentsToUpdate: string[],
  ): Promise<Record<string, string>>;
}

/** Parameters for {@link GepaEngine.optimize}. */
export interface GepaOptimizeParams {
  /** The candidate the search starts from. */
  seedCandidate: Record<string, string>;

  /** UIDs of the examples the search may select on. */
  trainset: string[];

  /** UIDs of the examples the engine reports scores against. */
  valset: string[];

  /** The bridge back to the system being optimized. */
  adapter: GepaAdapter;

  /** The maximum number of evaluations the search may make. */
  maxMetricCalls: number;

  /** The model call the engine uses to propose a rewrite. */
  reflectionLm: ReflectionLm;

  /** The number of examples the engine reflects over at a time. */
  reflectionMinibatchSize: number;

  /** Where the engine writes intermediate and final results, if anywhere. */
  runDir?: string;
}

/** What a GEPA engine reports when its search finishes. */
export interface GepaRunResult {
  /** The candidates on the Pareto front. */
  candidates: Array<Record<string, string>>;

  /** The validation score of each candidate, in `candidates` order. */
  valAggregateScores: number[];

  /** The full engine result, for callers that want more than the front. */
  details: Record<string, unknown>;
}

/** A GEPA search engine. */
export interface GepaEngine {
  optimize(params: GepaOptimizeParams): Promise<GepaRunResult>;
}
