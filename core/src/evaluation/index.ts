/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers `ResponseEvaluator` and the
 * substrate that evaluator stands on.
 */

export type {Invocation} from './eval_case.js';
export {
  EvalStatus,
  PrebuiltMetrics,
  getMetricThreshold,
} from './eval_metrics.js';
export type {BaseCriterion, EvalMetric} from './eval_metrics.js';
export {Evaluator} from './evaluator.js';
export type {EvaluationResult, PerInvocationResult} from './evaluator.js';
export {RougeEvaluator} from './final_response_match_v1.js';
export {ResponseEvaluator} from './response_evaluator.js';
export type {ResponseEvaluatorOptions} from './response_evaluator.js';
export {rouge1Score, tokenizeForRouge} from './rouge_scorer.js';
export type {RougeScore} from './rouge_scorer.js';
export {SingleTurnVertexAiEvalFacade} from './vertex_ai_eval_facade.js';
export type {
  VertexAggregatedMetricResult,
  VertexAiEvalClient,
  VertexAiEvalFacadeOptions,
  VertexAiEvalRequest,
  VertexEvalCaseRow,
  VertexEvalMetricSpec,
  VertexEvaluationDataset,
  VertexEvaluationResult,
} from './vertex_ai_eval_facade.js';
