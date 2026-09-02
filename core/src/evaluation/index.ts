/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the contract every metric
 * evaluator implements, and the data types that contract names.
 */

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
export type {BaseCriterion} from './eval_metrics.js';
export type {RubricScore} from './eval_rubrics.js';
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
  EvaluatorClassLike,
  PerInvocationResult,
} from './evaluator.js';
export type {
  UserBehavior,
  UserPersona,
} from './simulation/user_simulator_personas.js';
