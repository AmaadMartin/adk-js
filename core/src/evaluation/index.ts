/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the two facades over the
 * Vertex AI Gen AI evaluation service, and the data types they name.
 */

export type {AgentDetails, AppDetails} from './app_details.js';
export type {ConversationScenario} from './conversation_scenarios.js';
export {isInvocationEvents} from './eval_case.js';
export type {
  IntermediateData,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  InvocationEvents,
} from './eval_case.js';
export {EvalStatus} from './eval_metrics.js';
export type {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from './evaluator.js';
export {
  MultiTurnVertexAiEvalFacade,
  SingleTurnVertexAiEvalFacade,
  VertexAiEvalFacade,
  resolveVertexAiEvalClientConfig,
} from './vertex_ai_eval_facade.js';
export type {
  VertexAgentConfig,
  VertexAgentData,
  VertexAgentEvent,
  VertexAggregatedMetricResult,
  VertexAiEvalClient,
  VertexAiEvalClientConfig,
  VertexAiEvalFacadeOptions,
  VertexAiEvalRequest,
  VertexConversationTurn,
  VertexEvalCase,
  VertexEvalCaseRow,
  VertexEvalMetricSpec,
  VertexEvaluationDataset,
  VertexEvaluationResult,
} from './vertex_ai_eval_facade.js';
