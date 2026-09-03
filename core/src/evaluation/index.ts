/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the eval case data model, the
 * accessors that read a recorded trajectory, the contract every metric
 * evaluator implements, and the `ResponseEvaluator` that stands on it.
 */

export type {AgentDetails, AppDetails} from './app_details.js';
export type {ConversationScenario} from './conversation_scenarios.js';
export {
  getAllToolCalls,
  getAllToolCallsWithResponses,
  getAllToolResponses,
  isIntermediateData,
  isInvocationEvents,
  validateEvalCase,
} from './eval_case.js';
export type {
  EvalCase,
  IntermediateData,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  InvocationEvents,
  SessionInput,
  SessionState,
  StaticConversation,
  ToolCallAndResponse,
} from './eval_case.js';
export {
  EvalStatus,
  PrebuiltMetrics,
  getMetricThreshold,
} from './eval_metrics.js';
export type {BaseCriterion, EvalMetric} from './eval_metrics.js';
export type {Rubric, RubricContent, RubricScore} from './eval_rubrics.js';
export {
  BASE_CRITERION_TYPE,
  emptyEvaluationResult,
  getCriterionType,
  getEvalStatus,
  getTextFromContent,
  validateBaseCriterion,
  validateInvocationLengths,
} from './evaluator.js';
export type {
  CriterionType,
  EvaluationResult,
  Evaluator,
  EvaluatorClass,
  PerInvocationResult,
} from './evaluator.js';
export {RougeEvaluator} from './final_response_match_v1.js';
export {ResponseEvaluator} from './response_evaluator.js';
export type {ResponseEvaluatorOptions} from './response_evaluator.js';
export {rouge1Score, tokenizeForRouge} from './rouge_scorer.js';
export type {RougeScore} from './rouge_scorer.js';
export type {
  UserBehavior,
  UserPersona,
} from './simulation/user_simulator_personas.js';
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
