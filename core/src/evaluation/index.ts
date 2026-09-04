/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the eval case data model, the
 * evaluator contract a case is scored against, and the user simulator that
 * drives a case turn by turn.
 */

export type {AgentDetails, AppDetails} from './app_details.js';
export {evalModel, optionalField} from './common.js';
export type {
  EvalDumpOptions,
  EvalModel,
  EvalModelOptions,
  ExtraKeysPolicy,
} from './common.js';
export type {ConversationScenario} from './conversation_scenarios.js';
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
} from './eval_case.js';
export {EvalStatus} from './eval_metrics.js';
export type {Rubric, RubricContent, RubricScore} from './eval_rubrics.js';
export type {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from './evaluator.js';
export {StaticUserSimulator} from './simulation/static_user_simulator.js';
export {
  BASE_USER_SIMULATOR_CONFIG_NAME,
  UserSimulatorStatus,
  getRegisteredUserSimulator,
  parseBaseUserSimulatorConfig,
  registerUserSimulator,
  registeredUserSimulatorTypes,
  unpackUserSimulatorConfig,
  validateNextUserMessage,
} from './simulation/user_simulator.js';
export type {
  BaseUserSimulatorConfig,
  NextUserMessage,
  UserSimulator,
  UserSimulatorFactory,
} from './simulation/user_simulator.js';
export type {
  UserBehavior,
  UserPersona,
} from './simulation/user_simulator_personas.js';
export {UserSimulatorProvider} from './simulation/user_simulator_provider.js';
