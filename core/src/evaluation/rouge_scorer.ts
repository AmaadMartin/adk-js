/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** ROUGE-1 precision, recall and f-measure for one candidate/reference pair. */
export interface RougeScore {
  /** Share of the candidate's words that the reference also has, in [0, 1]. */
  precision: number;
  /** Share of the reference's words that the candidate also has, in [0, 1]. */
  recall: number;
  /** Harmonic mean of precision and recall, in [0, 1]. */
  fmeasure: number;
}

/** Matches one run of Unicode letters or digits. */
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * Splits `text` into lowercase unigrams and drops every other character.
 *
 * The pattern keeps Unicode letters and digits, so text in a non-Latin script
 * still produces tokens. A script written without spaces (Chinese, Japanese,
 * Thai) gives one token per run rather than one per character, and the
 * tokenizer applies no stemming.
 *
 * @param text The text to split.
 * @returns The tokens, in order. Empty when `text` holds no letter or digit.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_PATTERN) ?? [];
}

/**
 * Scores the unigram overlap of `candidate` against `reference`.
 *
 * The overlap is a multiset intersection, so a word the candidate repeats
 * counts only as often as the reference repeats it. Word order does not
 * change the score. Two texts that share no word score 0, and so does an
 * empty text on either side.
 *
 * @param candidate The generated text to score.
 * @param reference The golden text to score against.
 * @returns The precision, recall and f-measure of the overlap.
 */
export function rouge1Score(candidate: string, reference: string): RougeScore {
  const candidateTokens = tokenize(candidate);
  const referenceTokens = tokenize(reference);
  const overlap = countOverlap(candidateTokens, referenceTokens);
  if (overlap === 0) {
    return {precision: 0, recall: 0, fmeasure: 0};
  }

  const precision = overlap / candidateTokens.length;
  const recall = overlap / referenceTokens.length;
  return {
    precision,
    recall,
    fmeasure: (2 * precision * recall) / (precision + recall),
  };
}

/** Counts the tokens the two lists share, clipped by how often each repeats. */
function countOverlap(
  candidateTokens: string[],
  referenceTokens: string[],
): number {
  const referenceCounts = countTokens(referenceTokens);
  let overlap = 0;
  for (const [token, count] of countTokens(candidateTokens)) {
    overlap += Math.min(count, referenceCounts.get(token) ?? 0);
  }
  return overlap;
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
