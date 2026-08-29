/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalTurn} from './eval_types.js';

/**
 * Scores the agent's final response against the reference recorded for a turn.
 *
 * adk-python asks Vertex AI for its `rouge_1` metric. That is a hosted call to
 * count shared words, so this computes the same F-measure locally: the eval
 * needs no cloud project and costs nothing.
 */

/**
 * Splits text into unigrams the way the ROUGE reference tokenizer does, with
 * stemming off: lowercase, then every run of non-alphanumeric characters is a
 * separator.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token !== '');
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * How many unigrams the two sides share, counted as multisets, so a word
 * repeated three times on one side and once on the other counts once.
 */
function countOverlap(candidate: string[], reference: string[]): number {
  const referenceCounts = countTokens(reference);
  let overlap = 0;
  for (const [token, count] of countTokens(candidate)) {
    overlap += Math.min(count, referenceCounts.get(token) ?? 0);
  }
  return overlap;
}

/**
 * The ROUGE-1 F-measure of `candidate` against `reference`, in [0, 1]. A score
 * near 1 means the two texts use the same words.
 *
 * Sharing no word scores 0, and so does an empty side, which is the case that
 * would otherwise divide by zero.
 */
export function rouge1FMeasure(candidate: string, reference: string): number {
  const candidateTokens = tokenize(candidate);
  const referenceTokens = tokenize(reference);

  const overlap = countOverlap(candidateTokens, referenceTokens);
  if (overlap === 0) {
    return 0;
  }

  const precision = overlap / candidateTokens.length;
  const recall = overlap / referenceTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * The mean ROUGE-1 F-measure over the turns that recorded a `reference`.
 *
 * Returns `undefined` when no turn recorded one. The caller reports that as
 * `NOT_EVALUATED`, which is honest: eval data that asks for nothing in
 * particular has not scored 0, it has not been scored.
 */
export function evaluateResponseMatch(turns: EvalTurn[]): number | undefined {
  const scores = turns.flatMap((turn) =>
    turn.reference ? [rouge1FMeasure(turn.response ?? '', turn.reference)] : [],
  );

  if (scores.length === 0) {
    return undefined;
  }

  return scores.reduce((total, score) => total + score, 0) / scores.length;
}
