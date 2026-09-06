/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AGENT_PROMPT_NAME,
  type EvaluationBatch,
  type GepaAdapter,
} from '@google/adk';

/** Per-example scores, keyed by candidate prompt and then by example UID. */
export type ScoreTable = Record<string, Record<string, number>>;

/** One `evaluate` call the engine made. */
export interface EvaluateCall {
  /** The example UIDs the engine asked for. */
  batch: string[];

  /** The prompt the evaluated candidate carried. */
  prompt: string;

  /** Whether the engine asked for trajectories. */
  captureTraces: boolean;
}

/** The adapter shape {@link DefaultGepaEngine} drives. */
type PromptAdapter = GepaAdapter<
  string,
  Record<string, unknown>,
  Record<string, unknown>
>;

/**
 * An adapter that scores a prompt from a fixed table and records every call.
 *
 * It supplies no `proposeNewTexts`, so an engine falls back to its own
 * proposer.
 */
export class TableAdapter implements PromptAdapter {
  /** Every `evaluate` call, in order. */
  readonly evaluations: EvaluateCall[] = [];

  constructor(private readonly scores: ScoreTable) {}

  async evaluate(
    batch: string[],
    candidate: Record<string, string>,
    captureTraces = false,
  ): Promise<
    EvaluationBatch<Record<string, unknown>, Record<string, unknown>>
  > {
    const prompt = candidate[AGENT_PROMPT_NAME];
    this.evaluations.push({batch, prompt, captureTraces});
    const row = this.scores[prompt];
    if (row === undefined) {
      throw new Error(`The score table has no row for prompt "${prompt}".`);
    }
    return {
      outputs: batch.map((id) => ({id})),
      scores: batch.map((id) => row[id]),
      trajectories: batch.map((id) => ({id, prompt})),
    };
  }

  makeReflectiveDataset(
    candidate: Record<string, string>,
    evalBatch: EvaluationBatch<
      Record<string, unknown>,
      Record<string, unknown>
    >,
    componentsToUpdate: string[],
  ): Record<string, Array<Record<string, unknown>>> {
    const rows = evalBatch.scores.map((score, index) => ({
      prompt: candidate[AGENT_PROMPT_NAME],
      score,
      trajectory: evalBatch.trajectories?.[index],
    }));
    return Object.fromEntries(
      componentsToUpdate.map((component) => [component, rows]),
    );
  }
}

/** A {@link TableAdapter} that rewrites the prompt itself. */
export class ProposingTableAdapter extends TableAdapter {
  /** How many times the engine asked this adapter to propose. */
  proposals = 0;

  constructor(
    scores: ScoreTable,
    private readonly rewrites: string[],
  ) {
    super(scores);
  }

  async proposeNewTexts(
    _candidate: Record<string, string>,
    _reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
    componentsToUpdate: string[],
  ): Promise<Record<string, string>> {
    const rewrite = this.rewrites[this.proposals];
    this.proposals += 1;
    return Object.fromEntries(
      componentsToUpdate.map((component) => [component, rewrite]),
    );
  }
}

/** A reflection model that hands back scripted rewrites, in order. */
export class ScriptedReflector {
  /** Every prompt the engine sent, in order. */
  readonly prompts: string[] = [];

  constructor(private readonly rewrites: string[]) {}

  /** The call an engine takes as its `reflectionLm`. */
  readonly reflect = async (prompt: string): Promise<string> => {
    this.prompts.push(prompt);
    const rewrite = this.rewrites[this.prompts.length - 1];
    return rewrite ?? this.rewrites[this.rewrites.length - 1];
  };
}

/** Returns the total number of examples the engine evaluated. */
export function metricCalls(adapter: TableAdapter): number {
  return adapter.evaluations.reduce(
    (total, call) => total + call.batch.length,
    0,
  );
}

/** Returns the prompt of every candidate the engine reflected on. */
export function parentPrompts(adapter: TableAdapter): string[] {
  return adapter.evaluations
    .filter((call) => call.captureTraces)
    .filter((_call, index) => index % 2 === 0)
    .map((call) => call.prompt);
}
