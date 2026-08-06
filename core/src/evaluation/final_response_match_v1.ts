/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {EvalMetric} from './eval_metrics.js';
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';
import {porterStem} from './rouge/porter_stemmer.js';

// Unicode code-point ranges of scripts that are written without inter-word
// spaces. CJK scripts are tokenized one character per token; the "non-spaced"
// scripts below are tokenized into grapheme clusters (a base character plus any
// trailing combining marks).
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0xac00, 0xd7af], // Hangul Syllables
];

const NON_SPACED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0e00, 0x0e7f], // Thai
  [0x0e80, 0x0eff], // Lao
  [0x1780, 0x17ff], // Khmer
  [0x1000, 0x109f], // Myanmar
];

// Combining marks (Unicode category "M") are not alphanumeric on their own but
// must stay attached to the preceding base character.
const COMBINING_MARK_RE = /\p{M}/u;
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;

function inRanges(
  codePoint: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  return ranges.some(([min, max]) => codePoint >= min && codePoint <= max);
}

/**
 * Returns whether `char` belongs to a CJK (Chinese, Japanese, Korean) script.
 */
export function isCjk(char: string): boolean {
  return inRanges(char.codePointAt(0) ?? -1, CJK_RANGES);
}

/**
 * Returns whether `char` belongs to a non-spaced script (Thai, Lao, Khmer,
 * Myanmar).
 */
export function isNonSpacedScript(char: string): boolean {
  return inRanges(char.codePointAt(0) ?? -1, NON_SPACED_RANGES);
}

/**
 * Returns whether `char` is a word character: an alphanumeric character or a
 * combining mark.
 */
export function isWordChar(char: string): boolean {
  return WORD_CHAR_RE.test(char);
}

function isAscii(word: string): boolean {
  return [...word].every((char) => char.codePointAt(0)! <= 0x7f);
}

/**
 * Tokenizes text the way the reference ROUGE default tokenizer does: lowercase,
 * replace non-alphanumeric runs with spaces, split on whitespace, optionally
 * Porter-stem tokens longer than 3 characters, and drop invalid tokens.
 *
 * @param text The text to tokenize.
 * @param useStemmer Whether to Porter-stem tokens longer than 3 characters.
 */
export function defaultTokenize(text: string, useStemmer: boolean): string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  let tokens = normalized.split(/\s+/);
  if (useStemmer) {
    tokens = tokens.map((token) =>
      token.length > 3 ? porterStem(token) : token,
    );
  }
  return tokens.filter((token) => /^[a-z0-9]+$/.test(token));
}

/**
 * Tokenizer that keeps non-ASCII word characters and splits CJK/non-spaced
 * characters.
 *
 * The default ROUGE tokenizer discards any character outside `[a-z0-9]`, so
 * text in non-Latin scripts (e.g. Thai, Chinese, Arabic) tokenizes to nothing
 * and always scores 0. This tokenizer keeps Unicode word characters, normalizes
 * Unicode variants (NFKC), splits non-spaced CJK characters at the character
 * level, bundles non-spaced scripts by grapheme clusters (base character plus
 * attached combining marks), and delegates ASCII tokens to the default
 * tokenizer.
 *
 * Languages written without spaces are tokenized at the character or grapheme
 * cluster level rather than at true word granularity, so ROUGE-1 unigram
 * overlap for these languages operates on character/grapheme cluster units.
 */
export class UnicodeAwareTokenizer {
  private readonly useStemmer: boolean;

  constructor(useStemmer = false) {
    this.useStemmer = useStemmer;
  }

  tokenize(text: string): string[] {
    const normalized = text.normalize('NFKC').toLowerCase();
    const processedChars: string[] = [];
    for (const char of normalized) {
      if (isCjk(char)) {
        processedChars.push(' ', char, ' ');
      } else if (isNonSpacedScript(char)) {
        if (COMBINING_MARK_RE.test(char)) {
          // Combining mark: attach directly to the previous base character.
          processedChars.push(char);
        } else {
          // Base character: start a new grapheme cluster with a leading space.
          processedChars.push(' ', char);
        }
      } else if (isWordChar(char)) {
        processedChars.push(char);
      } else {
        processedChars.push(' ');
      }
    }
    const words = processedChars
      .join('')
      .split(/\s+/)
      .filter((word) => word.length > 0);
    const tokens: string[] = [];
    for (const word of words) {
      if (isAscii(word)) {
        tokens.push(...defaultTokenize(word, this.useStemmer));
      } else {
        tokens.push(word);
      }
    }
    return tokens;
  }
}

/**
 * ROUGE-1 precision, recall, and f-measure between a candidate and reference.
 */
export interface Rouge1Score {
  /** Fraction of candidate unigrams that also appear in the reference. */
  precision: number;
  /** Fraction of reference unigrams that also appear in the candidate. */
  recall: number;
  /** Harmonic mean of precision and recall. */
  fmeasure: number;
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function fmeasure(precision: number, recall: number): number {
  return precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0.0;
}

/**
 * Calculates the ROUGE-1 score between a candidate and reference text.
 *
 * ROUGE-1 measures the overlap of unigrams (single tokens) between the
 * candidate and reference texts. Orientation matches the reference
 * implementation: the reference text is the target and the candidate is the
 * prediction.
 *
 * @param candidate The generated text to be evaluated.
 * @param reference The ground-truth text to compare against.
 */
export function calculateRouge1Scores(
  candidate: string,
  reference: string,
): Rouge1Score {
  const tokenizer = new UnicodeAwareTokenizer(true);
  const targetCounts = countTokens(tokenizer.tokenize(reference));
  const predictionCounts = countTokens(tokenizer.tokenize(candidate));

  let intersection = 0;
  let targetTotal = 0;
  for (const [token, targetCount] of targetCounts) {
    targetTotal += targetCount;
    intersection += Math.min(targetCount, predictionCounts.get(token) ?? 0);
  }
  let predictionTotal = 0;
  for (const count of predictionCounts.values()) {
    predictionTotal += count;
  }

  const precision = intersection / Math.max(predictionTotal, 1);
  const recall = intersection / Math.max(targetTotal, 1);
  return {precision, recall, fmeasure: fmeasure(precision, recall)};
}

function getTextFromContent(content?: Content): string {
  if (content?.parts) {
    return content.parts
      .filter((part) => part.text)
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

function getEvalStatus(score: number, threshold?: number): EvalStatus {
  return threshold !== undefined && score >= threshold
    ? EvalStatus.PASSED
    : EvalStatus.FAILED;
}

/**
 * Evaluates whether an agent's final response matches a golden/expected final
 * response using the ROUGE-1 metric.
 *
 * Value range for this metric is [0, 1], with values closer to 1 more
 * desirable.
 */
export class RougeEvaluator extends Evaluator {
  private readonly evalMetric: EvalMetric;

  constructor(evalMetric: EvalMetric) {
    super();
    this.evalMetric = evalMetric;
  }

  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult {
    if (expectedInvocations === undefined) {
      throw new Error('expected_invocations is required for this metric.');
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);
    void conversationScenario; // not used by this metric.

    let totalScore = 0.0;
    const perInvocationResults: PerInvocationResult[] = [];
    for (let i = 0; i < actualInvocations.length; i++) {
      const actual = actualInvocations[i];
      const expected = expectedInvocations[i];
      const reference = getTextFromContent(expected.finalResponse);
      const response = getTextFromContent(actual.finalResponse);
      const score = calculateRouge1Scores(response, reference).fmeasure;
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation: expected,
        score,
        evalStatus: getEvalStatus(score, this.evalMetric.threshold),
      });
      totalScore += score;
    }

    if (perInvocationResults.length > 0) {
      const overallScore = totalScore / perInvocationResults.length;
      return {
        overallScore,
        overallEvalStatus: getEvalStatus(
          overallScore,
          this.evalMetric.threshold,
        ),
        perInvocationResults,
      };
    }

    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    };
  }
}
