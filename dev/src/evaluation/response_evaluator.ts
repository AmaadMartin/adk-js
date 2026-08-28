/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalTurn} from './eval_types.js';

/**
 * Splits text into unigrams the way the `rouge_score` package's default
 * tokenizer does: lowercase the text, then treat every run of characters
 * outside `[a-z0-9]` as a separator.
 *
 * Non-ASCII letters are separators too, so this scores English text. That is
 * the tokenizer adk-python's ROUGE score is computed with, and the two SDKs
 * have to agree on a score before they can agree on a threshold.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Returns the ROUGE-1 F-measure of `candidate` against `reference`, in [0, 1].
 *
 * The overlap is a multiset intersection, so a word the candidate repeats
 * counts only as often as the reference repeats it. An empty side scores 0.
 */
export function rougeOneFMeasure(candidate: string, reference: string): number {
  const candidateTokens = tokenize(candidate);
  const referenceTokens = tokenize(reference);
  if (candidateTokens.length === 0 || referenceTokens.length === 0) {
    return 0;
  }

  const referenceCounts = countTokens(referenceTokens);
  let overlap = 0;
  for (const [token, count] of countTokens(candidateTokens)) {
    overlap += Math.min(count, referenceCounts.get(token) ?? 0);
  }

  const precision = overlap / candidateTokens.length;
  const recall = overlap / referenceTokens.length;
  if (precision + recall === 0) {
    return 0;
  }
  return (2 * precision * recall) / (precision + recall);
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Returns the mean ROUGE-1 F-measure over every turn that records a
 * `reference`, or `undefined` when no turn records one.
 *
 * A turn without a `reference` states no expectation for the agent's prose, so
 * it is not scored; adk-python drops the metric for the same reason. A turn
 * that records a `reference` and produced no response scores 0.
 *
 * @param dataset One entry per conversation, each a list of scored turns.
 */
export function evaluateResponseMatch(
  dataset: EvalTurn[][],
): number | undefined {
  const scores: number[] = [];
  for (const turn of dataset.flat()) {
    if (turn.reference != null) {
      scores.push(rougeOneFMeasure(turn.response ?? '', turn.reference));
    }
  }

  if (scores.length === 0) {
    return undefined;
  }
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}
