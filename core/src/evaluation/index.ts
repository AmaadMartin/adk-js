/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The user simulation half of the ADK evaluation module, a parity port of
 * `google/adk-python`'s `google/adk/evaluation/simulation`.
 *
 * The eval case, evaluator and metric types here are the minimum the
 * simulators name in their own signatures. The rest of the evaluation
 * subsystem lands with the modules that use it.
 */

export {evalModel, optionalField} from './common.js';
export type {
  EvalDumpOptions,
  EvalModel,
  EvalModelOptions,
  ExtraKeysPolicy,
} from './common.js';
export type {ConversationScenario} from './conversation_scenarios.js';
export type {EvalCase, Invocation, StaticConversation} from './eval_case.js';
export {EvalStatus} from './eval_metrics.js';
export type {RubricScore} from './eval_rubrics.js';
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
  unregisterUserSimulator,
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
