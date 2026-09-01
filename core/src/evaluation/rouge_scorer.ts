/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local ROUGE-1 scorer, ported from the `rouge_score` usage in
 * `adk-python`'s `final_response_match_v1.py`.
 *
 * Divergence from `adk-python`: tokens are not stemmed. `rouge_score` stems
 * tokens longer than three characters with NLTK's Porter stemmer, which has no
 * equivalent here and would need either a new dependency or an unverifiable
 * hand port. Scores therefore differ from Python's for texts whose only
 * overlap is between two inflections of one word.
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

/** Characters written without spaces and tokenized one per character. */
const CJK_RANGES: Array<[number, number]> = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0xac00, 0xd7af], // Hangul Syllables
];

/** Scripts written without spaces and tokenized by grapheme cluster. */
const NON_SPACED_SCRIPT_RANGES: Array<[number, number]> = [
  [0x0e00, 0x0e7f], // Thai
  [0x0e80, 0x0eff], // Lao
  [0x1780, 0x17ff], // Khmer
  [0x1000, 0x109f], // Myanmar
];

const COMBINING_MARK = /\p{M}/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function inRanges(char: string, ranges: Array<[number, number]>): boolean {
  const code = char.codePointAt(0)!;
  return ranges.some(([start, end]) => code >= start && code <= end);
}

/**
 * Splits text into ROUGE unigrams, keeping non-Latin word characters.
 *
 * The `rouge_score` default tokenizer drops every character outside `[a-z0-9]`,
 * so text in a non-Latin script tokenizes to nothing and always scores 0. This
 * tokenizer normalizes to NFKC, keeps Unicode word characters, splits CJK text
 * one token per character, and keeps a combining mark attached to the base
 * character it modifies.
 *
 * Languages written without spaces are tokenized by character or grapheme
 * cluster rather than by word, because dictionary-based segmentation needs a
 * heavy external dependency. ROUGE-1 overlap for those languages therefore
 * counts those units instead of full words.
 */
export function tokenizeForRouge(text: string): string[] {
  const processed: string[] = [];
  for (const char of text.normalize('NFKC').toLowerCase()) {
    if (inRanges(char, CJK_RANGES)) {
      processed.push(' ', char, ' ');
    } else if (inRanges(char, NON_SPACED_SCRIPT_RANGES)) {
      if (COMBINING_MARK.test(char)) {
        processed.push(char);
      } else {
        processed.push(' ', char);
      }
    } else if (WORD_CHAR.test(char)) {
      processed.push(char);
    } else {
      processed.push(' ');
    }
  }
  return processed.join('').split(/\s+/).filter(Boolean);
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
