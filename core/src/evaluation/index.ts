/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the multi-turn facade over the
 * Vertex AI Gen AI evaluation service, and the data types it names.
 */

export type {AgentDetails, AppDetails} from './app_details.js';
export type {ConversationScenario} from './conversation_scenarios.js';
export type {
  Invocation,
  InvocationEvent,
  InvocationEvents,
} from './eval_case.js';
export {EvalStatus, PrebuiltMetrics} from './eval_metrics.js';
export type {BaseCriterion, EvalMetric} from './eval_metrics.js';
export type {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from './evaluator.js';
export {MultiTurnTrajectoryQualityV1Evaluator} from './multi_turn_trajectory_quality_evaluator.js';
export type {MultiTurnTrajectoryQualityV1EvaluatorOptions} from './multi_turn_trajectory_quality_evaluator.js';
export {MultiTurnVertexAiEvalFacade} from './vertex_ai_eval_facade.js';
export type {
  VertexAgentConfig,
  VertexAgentData,
  VertexAgentEvent,
  VertexAggregatedMetricResult,
  VertexAiEvalClient,
  VertexAiEvalFacadeOptions,
  VertexAiEvalRequest,
  VertexConversationTurn,
  VertexEvalCase,
  VertexEvalMetricSpec,
  VertexEvaluationDataset,
  VertexEvaluationResult,
} from './vertex_ai_eval_facade.js';
