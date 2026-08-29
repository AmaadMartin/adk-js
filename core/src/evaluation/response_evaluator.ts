/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {getLogger} from '../utils/logger.js';
import {rouge1Score} from './rouge_scorer.js';

const logger = getLogger();

/**
 * A recorded tool call in an eval turn.
 *
 * The field names are snake_case because they are keys of the `*.test.json`
 * eval files that adk-js and adk-python both read.
 */
export interface ToolUse {
  /** Name of the called tool. */
  tool_name: string;
  /** Arguments the tool was called with. */
  tool_input?: Record<string, unknown>;
}

/**
 * One turn of a recorded conversation.
 *
 * The field names are snake_case because they are keys of the `*.test.json`
 * eval files that adk-js and adk-python both read.
 */
export interface EvalTurn {
  /** What the user asked. */
  query?: string;
  /** The agent's final natural-language answer. */
  response?: string;
  /** The golden answer that `response` is scored against. */
  reference?: string;
  /** The tool calls the agent was expected to make. */
  expected_tool_use?: ToolUse[];
  /** The tool calls the agent actually made. */
  actual_tool_use?: ToolUse[];
}

/** Evaluation criteria, named as adk-python names them. */
export enum ResponseCriterion {
  /** Coherence of the response, judged by the Vertex AI evaluation service. */
  RESPONSE_EVALUATION_SCORE = 'response_evaluation_score',
  /** ROUGE-1 similarity of the response to the turn's `reference`. */
  RESPONSE_MATCH_SCORE = 'response_match_score',
}

/** Name of the metric that `response_match_score` produces. */
export const ROUGE_1_METRIC = 'rouge_1';

/** Aggregate result of scoring an eval dataset. */
export interface ResponseEvaluationSummary {
  /** Number of turns scored, across every session. */
  rowCount: number;
  /** Mean score per metric, keyed by metric name. */
  summaryMetrics: Record<string, number>;
  /** Per-turn scores per metric, in flattened dataset order. */
  perTurnScores: Record<string, number[]>;
}

/**
 * Scores an agent's final responses against their golden references.
 *
 * `response_match_score` is the one supported criterion. It reports the
 * ROUGE-1 f-measure of each turn's `response` against its `reference`, in
 * [0, 1], under the `rouge_1` metric name. The score measures word overlap
 * only, so it does not tell you the answer is correct: "the light is on" and
 * "the light is off" share almost every word.
 *
 * The criterion applies only when the first turn of the first session carries
 * the key it needs. adk-python probes that one turn to pick its metrics, and
 * this port keeps the behaviour so that both read an eval file the same way.
 *
 * Unlike adk-python, which delegates to the Vertex AI evaluation service, this
 * function computes locally. It therefore returns its own summary shape rather
 * than the service's `rouge_1/mean` and `rouge_1/std` keys.
 *
 * @param rawEvalDataset One entry per session, each a list of turns. Parsed
 *     eval files can hold `null`, which is rejected.
 * @param evaluationCriteria The criteria to score, as `ResponseCriterion`
 *     values. This function ignores a name it does not know.
 * @returns The row count, the mean of each metric and its per-turn scores.
 * @throws InputValidationError When the dataset is empty, or when the caller
 *     asks for `response_evaluation_score`.
 */
export function evaluateResponses(
  rawEvalDataset: EvalTurn[][] | null,
  evaluationCriteria: string[],
): ResponseEvaluationSummary {
  if (!rawEvalDataset || rawEvalDataset.length === 0) {
    throw new InputValidationError('The evaluation dataset is empty.');
  }

  const firstTurn = rawEvalDataset[0][0];
  if (selectsCoherence(firstTurn, evaluationCriteria)) {
    throw new InputValidationError(
      `${ResponseCriterion.RESPONSE_EVALUATION_SCORE} needs the Vertex AI ` +
        'evaluation service, which the JavaScript SDKs do not expose. Use ' +
        `${ResponseCriterion.RESPONSE_MATCH_SCORE} instead.`,
    );
  }

  const turns = rawEvalDataset.flat();
  if (!selectsResponseMatch(firstTurn, evaluationCriteria)) {
    logger.debug('No supported criterion selected; returning no metrics.');
    return {rowCount: turns.length, summaryMetrics: {}, perTurnScores: {}};
  }

  const scores = turns.map((turn, index) => {
    const score = rouge1Score(turn.response ?? '', turn.reference ?? '');
    logger.debug(`Turn ${index + 1} ${ROUGE_1_METRIC}: ${score.fmeasure}`);
    return score.fmeasure;
  });
  // The criterion only applies when the first turn exists, so `scores` holds
  // at least one score here and the divisor is never zero.
  const total = scores.reduce((sum, score) => sum + score, 0);
  const summary = {
    rowCount: turns.length,
    summaryMetrics: {[ROUGE_1_METRIC]: total / scores.length},
    perTurnScores: {[ROUGE_1_METRIC]: scores},
  };
  logger.debug(
    `Scored ${summary.rowCount} turns; ${ROUGE_1_METRIC} mean ` +
      `${summary.summaryMetrics[ROUGE_1_METRIC]}.`,
  );
  return summary;
}

function selectsCoherence(
  firstTurn: EvalTurn | undefined,
  criteria: string[],
): boolean {
  return (
    criteria.includes(ResponseCriterion.RESPONSE_EVALUATION_SCORE) &&
    hasKey(firstTurn, 'query') &&
    hasKey(firstTurn, 'expected_tool_use')
  );
}

function selectsResponseMatch(
  firstTurn: EvalTurn | undefined,
  criteria: string[],
): boolean {
  return (
    criteria.includes(ResponseCriterion.RESPONSE_MATCH_SCORE) &&
    hasKey(firstTurn, 'reference')
  );
}

function hasKey(turn: EvalTurn | undefined, key: keyof EvalTurn): boolean {
  return turn !== undefined && key in turn;
}
