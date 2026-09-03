/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the
 * substrate that the single-turn Vertex AI metrics stand on.
 */

export type {Invocation} from './eval_case.js';
export {
  EvalStatus,
  PrebuiltMetrics,
  getMetricThreshold,
} from './eval_metrics.js';
export type {BaseCriterion, EvalMetric} from './eval_metrics.js';
export type {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from './evaluator.js';
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
