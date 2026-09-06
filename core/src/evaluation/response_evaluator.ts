/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';

/** A single tool invocation recorded on a turn. */
export interface ToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** One recorded interaction from an eval dataset. */
export interface EvalTurn {
  query?: string;
  response?: string;
  actualToolUse?: ToolUse[];
  expectedToolUse?: ToolUse[];
  reference?: string;
}

/** Criteria accepted by {@link ResponseEvaluator.evaluate}. */
export enum EvalCriterion {
  RESPONSE_EVALUATION_SCORE = 'response_evaluation_score',
  RESPONSE_MATCH_SCORE = 'response_match_score',
}

/**
 * Metric identifiers the evaluation service understands. The values are those
 * of `vertexai.evaluation.constants.Metric` in the Vertex AI Python SDK.
 */
export enum VertexEvalMetric {
  COHERENCE = 'coherence',
  ROUGE_1 = 'rouge_1',
}

/**
 * One row of the dataset handed to the evaluation service. The keys keep the
 * service's own spelling, so they are snake_case rather than camelCase.
 */
export interface EvalDatasetRow {
  prompt?: string;
  response?: string;
  actual_tool_use?: ToolUse[];
  reference_trajectory?: ToolUse[];
  reference?: string;
}

/** What the evaluation service returns for one run. */
export interface EvalRunResult {
  summaryMetrics: Record<string, number>;
  metricsTable: Array<Record<string, unknown>>;
}

/** The evaluation service, behind an interface so a caller can substitute it. */
export interface EvalBackend {
  performEval(
    dataset: EvalDatasetRow[],
    metrics: VertexEvalMetric[],
  ): Promise<EvalRunResult>;
}

/** Options for {@link ResponseEvaluator.evaluate}. */
export interface EvaluateOptions {
  /**
   * The evaluation service to run the metrics. This is required because
   * neither `@google/genai` nor `@google-cloud/vertexai` exposes an
   * evaluation-run API in Node, so there is nothing to default to.
   */
  backend: EvalBackend;
  /** Logs the summary metrics and the metrics table. Helpful when debugging. */
  printDetailedResults?: boolean;
}

/**
 * Chooses the metrics from the criteria and the keys the first turn carries.
 * Only that turn decides, matching adk-python.
 */
function selectMetrics(
  firstTurn: EvalTurn,
  criteria: EvalCriterion[],
): VertexEvalMetric[] {
  const metrics: VertexEvalMetric[] = [];
  if (
    criteria.includes(EvalCriterion.RESPONSE_EVALUATION_SCORE) &&
    'query' in firstTurn &&
    'expectedToolUse' in firstTurn
  ) {
    metrics.push(VertexEvalMetric.COHERENCE);
  }
  if (
    criteria.includes(EvalCriterion.RESPONSE_MATCH_SCORE) &&
    'reference' in firstTurn
  ) {
    metrics.push(VertexEvalMetric.ROUGE_1);
  }
  return metrics;
}

function toDatasetRow(turn: EvalTurn): EvalDatasetRow {
  return {
    prompt: turn.query,
    response: turn.response,
    actual_tool_use: turn.actualToolUse,
    reference_trajectory: turn.expectedToolUse,
    reference: turn.reference,
  };
}

/** Scores an agent's final natural-language responses. */
export class ResponseEvaluator {
  /**
   * Returns the summary metrics the evaluation service reports.
   *
   * `response_match_score` compares the agent's final response with the
   * `reference` recorded on the turn, using ROUGE. Its range is [0, 1], where
   * a higher score means stronger similarity.
   *
   * `response_evaluation_score` asks a model to judge how coherent the
   * response is, including its tool use. Its range is [0, 5], where a higher
   * score is better.
   *
   * @param rawEvalDataset One list of turns per recorded session.
   * @param evaluationCriteria The criteria to score.
   * @param options The backend, and whether to log the detailed results.
   */
  static async evaluate(
    rawEvalDataset: EvalTurn[][],
    evaluationCriteria: EvalCriterion[],
    options: EvaluateOptions,
  ): Promise<Record<string, number>> {
    const firstTurn = rawEvalDataset[0]?.[0];
    if (!firstTurn) {
      throw new Error('The evaluation dataset is empty.');
    }

    const metrics = selectMetrics(firstTurn, evaluationCriteria);
    const rows = rawEvalDataset.flat().map(toDatasetRow);
    const result = await options.backend.performEval(rows, metrics);

    if (options.printDetailedResults) {
      logger.info(
        'Evaluation summary metrics:',
        JSON.stringify(result.summaryMetrics),
        JSON.stringify(result.metricsTable),
      );
    }
    return result.summaryMetrics;
  }
}
