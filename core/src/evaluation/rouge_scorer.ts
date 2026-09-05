/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local ROUGE-1 scorer, ported from the `rouge_score` usage in
 * `adk-python`'s `final_response_match_v1.py`.
 *
 * Two divergences from `adk-python`:
 *
 * 1. Tokens are not stemmed. `rouge_score` stems tokens longer than three
 *    characters with NLTK's Porter stemmer, which has no equivalent here and
 *    would need either a new dependency or an unverifiable hand port. Scores
 *    therefore differ from Python's for texts whose only overlap is between
 *    two inflections of one word.
 * 2. Text written without spaces is segmented into words by `Intl.Segmenter`,
 *    not into single characters. `adk-python` splits such text per character
 *    because dictionary segmentation would cost it a heavy dependency, so
 *    scores for Chinese, Japanese, Thai, Lao and Khmer count words here and
 *    characters there.
 */

/** The three ROUGE figures for one candidate/reference pair. */
export interface RougeScore {
  /** The share of candidate unigrams that appear in the reference. */
  precision: number;

  /** The share of reference unigrams that appear in the candidate. */
  recall: number;

  /** The harmonic mean of precision and recall. */
  fmeasure: number;
}

/**
 * The segmenter carries a fixed locale so that a score never depends on the
 * locale of the machine that computes it.
 */
const WORD_SEGMENTER = new Intl.Segmenter('en', {granularity: 'word'});

/**
 * Splits text into ROUGE unigrams.
 *
 * Text is folded to NFKC and lowercased, so a full-width and a half-width
 * spelling of one word count as the same token. Punctuation and whitespace
 * are dropped.
 */
export function tokenizeForRouge(text: string): string[] {
  const segments = WORD_SEGMENTER.segment(text.normalize('NFKC').toLowerCase());
  return [...segments]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Scores the unigram overlap between a candidate and a reference text.
 *
 * A token repeated in the candidate is credited at most as often as it appears
 * in the reference. All three figures are 0 when the texts share no token,
 * which also covers an empty text on either side.
 */
export function rouge1Score(candidate: string, reference: string): RougeScore {
  const candidateTokens = tokenizeForRouge(candidate);
  const referenceTokens = tokenizeForRouge(reference);
  const referenceCounts = countTokens(referenceTokens);

  let overlap = 0;
  for (const [token, count] of countTokens(candidateTokens)) {
    overlap += Math.min(count, referenceCounts.get(token) ?? 0);
  }

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
