/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the eval data model: the eval
 * case, the metrics and rubrics a case is scored against, and the results an
 * eval run writes.
 */

export {getDeveloperInstructions, getToolsByAgentName} from './app_details.js';
export type {AgentDetails, AppDetails} from './app_details.js';
export {evalModel, optionalField} from './common.js';
export type {
  EvalDumpOptions,
  EvalModel,
  EvalModelOptions,
  ExtraKeysPolicy,
} from './common.js';
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
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  EvalStatus,
  PrebuiltMetrics,
  ToolTrajectoryMatchType,
  getMetricThreshold,
  normalizeToolTrajectoryMatchType,
  parseHallucinationsCriterion,
  parseLlmAsAJudgeCriterion,
  parseMetricInfo,
  parseRubricsBasedCriterion,
  resolveJudgeModelOptions,
} from './eval_metrics.js';
export type {
  BaseCriterion,
  CriterionParser,
  EvalMetric,
  EvalMetricCriterion,
  HallucinationsCriterion,
  Interval,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
  LlmAsAJudgeMetric,
  LlmBackedUserSimulatorCriterion,
  MetricInfo,
  MetricInfoProvider,
  MetricValueInfo,
  ParsedLlmAsAJudgeCriterion,
  ParsedRubricsBasedCriterion,
  ResolvedJudgeModelOptions,
  RubricsBasedCriterion,
  Threshold,
  ToolTrajectoryCriterion,
} from './eval_metrics.js';
export type {EvalCaseResult, EvalSetResult} from './eval_result.js';
export type {Rubric, RubricContent, RubricScore} from './eval_rubrics.js';
export type {
  UserBehavior,
  UserPersona,
} from './simulation/user_simulator_personas.js';
