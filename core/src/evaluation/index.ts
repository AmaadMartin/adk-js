/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the `hallucinations_v1`
 * metric, the eval data model it reads, and the contract every metric
 * implements.
 */

export {getDeveloperInstructions, getToolsByAgentName} from './app_details.js';
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
export {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  EvalStatus,
  PrebuiltMetrics,
  ToolTrajectoryMatchType,
  normalizeToolTrajectoryMatchType,
  parseHallucinationsCriterion,
  resolveJudgeModelOptions,
} from './eval_metrics.js';
export type {
  BaseCriterion,
  EvalMetric,
  EvalMetricCriterion,
  HallucinationsCriterion,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
  LlmBackedUserSimulatorCriterion,
  ResolvedJudgeModelOptions,
  RubricsBasedCriterion,
  Threshold,
  ToolTrajectoryCriterion,
} from './eval_metrics.js';
export type {Rubric, RubricContent, RubricScore} from './eval_rubrics.js';
export {
  emptyEvaluationResult,
  getEvalStatus,
  getTextFromContent,
  validateInvocationLengths,
} from './evaluator.js';
export type {
  CriterionType,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from './evaluator.js';
// The metric's own segmentation, validation and context helpers stay internal,
// as they are in adk-python. Only the evaluator is public.
export {HallucinationsV1Evaluator} from './hallucinations_v1.js';
export {
  formatPromptTemplate,
  getToolDeclarationsAsJsonStr,
} from './llm_as_judge_utils.js';
export type {
  UserBehavior,
  UserPersona,
} from './simulation/user_simulator_personas.js';
