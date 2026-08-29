/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatAlignedTable} from '../utils/table_utils.js';
import {EvalTurn} from './eval_types.js';

/**
 * A turn that recorded a reference answer, so it can be scored.
 *
 * The schema types `reference` as nullish, and only the turns that carry one
 * contribute to the metric.
 */
type ScorableTurn = EvalTurn & {reference: string};

/** One scored turn, used by the detail table. */
interface ResponseRow {
  /** 1-based position within its conversation. */
  turn: number;
  query: string;
  response: string;
  reference: string;
  score: number;
}

/** Options for {@link evaluateResponses}. */
export interface EvaluateResponsesOptions {
  /** Prints a per-turn table of the response, the reference and the score. */
  printDetailedResults?: boolean;
}

/**
 * Runs of characters the ROUGE reference tokenizer treats as separators.
 *
 * `rouge_score`'s tokenizer lowercases the text and then replaces every
 * character outside `[a-z0-9]` with a space, so accented letters and any other
 * non-ASCII text are separators too. Matching it exactly is what keeps a score
 * here equal to the score adk-python reports for the same pair of strings.
 */
const NON_TOKEN_CHARACTERS = /[^a-z0-9]+/;

/** Splits `text` into ROUGE unigrams. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(NON_TOKEN_CHARACTERS)
    .filter((token) => token !== '');
}

/**
 * Returns the ROUGE-1 F-measure of `response` against `reference`, in [0, 1].
 *
 * Unigrams are counted as multisets, so a word repeated in the response only
 * matches as many times as the reference repeats it. A pair that shares no
 * word scores 0, which is also what makes an empty response or an empty
 * reference score 0 rather than divide by zero.
 */
export function rouge1FMeasure(response: string, reference: string): number {
  const responseCounts = countTokens(tokenize(response));
  const referenceCounts = countTokens(tokenize(reference));

  let overlap = 0;
  for (const [token, referenceCount] of referenceCounts) {
    overlap += Math.min(referenceCount, responseCounts.get(token) ?? 0);
  }
  if (overlap === 0) {
    return 0;
  }

  const precision = overlap / totalCount(responseCounts);
  const recall = overlap / totalCount(referenceCounts);
  return (2 * precision * recall) / (precision + recall);
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function totalCount(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
}

/**
 * Returns the mean ROUGE-1 F-measure over every turn that recorded a
 * `reference`, or `undefined` when no turn recorded one.
 *
 * `undefined` is how the caller learns the metric could not be applied, and it
 * is reported as `NOT_EVALUATED`. Returning 0 instead would fail the case for
 * eval data that simply never asked for the response to be scored.
 *
 * adk-python scores this with Vertex AI's hosted `rouge_1` metric. Computing
 * the same measure locally keeps the command usable without a Google Cloud
 * project, and keeps the eval run free of a network call.
 *
 * @param dataset One entry per conversation, each a list of scored turns.
 * @throws Error when the dataset holds no conversation.
 */
export function evaluateResponses(
  dataset: EvalTurn[][],
  options: EvaluateResponsesOptions = {},
): number | undefined {
  if (dataset.length === 0) {
    throw new Error('The evaluation dataset is empty.');
  }

  const rows = dataset.flatMap((conversation) =>
    conversation.flatMap((turn, index) =>
      hasReference(turn) ? [scoreTurn(turn, index + 1)] : [],
    ),
  );

  if (rows.length === 0) {
    return undefined;
  }

  if (options.printDetailedResults) {
    printDetailedResults(rows);
  }

  return rows.reduce((total, row) => total + row.score, 0) / rows.length;
}

function hasReference(turn: EvalTurn): turn is ScorableTurn {
  return typeof turn.reference === 'string';
}

function scoreTurn(turn: ScorableTurn, turnNumber: number): ResponseRow {
  const response = turn.response ?? '';
  return {
    turn: turnNumber,
    query: turn.query,
    response,
    reference: turn.reference,
    score: rouge1FMeasure(response, turn.reference),
  };
}

function printDetailedResults(rows: ResponseRow[]): void {
  const table = formatAlignedTable([
    ['query', 'response', 'reference', 'rouge_1'],
    ...rows.map((row) => [
      row.query,
      row.response,
      row.reference,
      row.score.toFixed(2),
    ]),
  ]);

  for (const line of table) {
    console.log(line);
  }
}
