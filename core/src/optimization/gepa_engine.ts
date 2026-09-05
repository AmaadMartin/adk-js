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
 * ADK does not bundle a GEPA search engine. adk-python imports the PyPI
 * package `gepa`; npm has no first-party equivalent, so the caller supplies an
 * engine that implements these types.
 */

/** GEPA's public LanguageModel input contract. */
export type GepaPrompt = string | Array<Record<string, unknown>>;

/** One GEPA reflection call. */
export type ReflectionLm = (prompt: GepaPrompt) => Promise<string>;

/** Per-example results for one candidate over one batch. */
export interface EvaluationBatch<OutputT, TrajectoryT> {
  /** One entry per batch example, in batch order. */
  outputs: OutputT[];

  /** One score per batch example, in batch order. Higher is better. */
  scores: number[];

  /** Absent unless the engine asked for traces. */
  trajectories?: TrajectoryT[] | null;
}

/** The bridge between a GEPA engine and the system being optimized. */
export interface GepaAdapter<DataInstT, TrajectoryT, OutputT> {
  /**
   * Scores one candidate over one batch of examples.
   *
   * @param batch The example UIDs to score the candidate on.
   * @param candidate A map from component name to that component's text.
   * @param captureTraces Whether the engine needs trajectories back.
   */
  evaluate(
    batch: DataInstT[],
    candidate: Record<string, string>,
    captureTraces?: boolean,
  ): Promise<EvaluationBatch<OutputT, TrajectoryT>>;

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
    evalBatch: EvaluationBatch<OutputT, TrajectoryT>,
    componentsToUpdate: string[],
  ): Record<string, Array<Record<string, unknown>>>;
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
  adapter: GepaAdapter<
    string,
    Record<string, unknown>,
    Record<string, unknown>
  >;

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
  toDict(): Record<string, unknown>;
}

/** A GEPA search engine. */
export interface GepaEngine {
  optimize(params: GepaOptimizeParams): Promise<GepaRunResult>;
}

/** Thrown when the optimizer runs without a GEPA engine. */
export const MISSING_GEPA_ENGINE_MESSAGE =
  'GEPARootAgentPromptOptimizer requires a GEPA engine, which ADK does not ' +
  'bundle. GEPA is an external search algorithm, so applications that do ' +
  'not optimize prompts are not made to carry it. Pass an implementation of ' +
  'the GepaEngine interface as `config.engine`.';

/**
 * Returns `engine`, or throws when the caller configured none.
 *
 * @param engine The engine the caller configured, if any.
 * @throws If `engine` is undefined, an error naming the feature and the field
 *   that fixes it.
 */
export function requireGepaEngine(engine?: GepaEngine): GepaEngine {
  if (!engine) {
    throw new Error(MISSING_GEPA_ENGINE_MESSAGE);
  }
  return engine;
}
