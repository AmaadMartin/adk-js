/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the eval case data model, the
 * accessors that read a recorded trajectory, the contract every metric
 * evaluator implements, the `ResponseEvaluator`, `LlmAsJudge`,
 * `FinalResponseMatchV2Evaluator`, `HallucinationsV1Evaluator`,
 * `SafetyEvaluatorV1`, `RubricBasedToolUseV1Evaluator`,
 * `RubricBasedFinalResponseQualityV1Evaluator`,
 * `MultiTurnTaskSuccessV1Evaluator`,
 * `MultiTurnToolUseQualityV1Evaluator` and
 * `MultiTurnTrajectoryQualityV1Evaluator` evaluators that stand on it,
 * the metric info providers that describe each prebuilt metric,
 * and the user simulation half under `./simulation`.
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
export {
  FinalResponseMatchV2Evaluator,
  formatAutoRaterPrompt,
  parseCritique,
} from './final_response_match_v2.js';
export type {AutoRaterPromptValues} from './final_response_match_v2.js';
// The metric's own segmentation, validation and context helpers stay internal,
// as they are in adk-python. Only the evaluator is public.
export {HallucinationsV1Evaluator} from './hallucinations_v1.js';
export {LlmAsJudge} from './llm_as_judge.js';
export type {AutoRaterScore, LlmAsJudgeOptions} from './llm_as_judge.js';
export {
  Label,
  PARTIALLY_VALID_LABELS,
  formatPromptTemplate,
  getAverageRubricScore,
  getGroundingMetadataAsJsonStr,
  getTextFromInvocation,
  getToolCallsAndResponsesAsJsonStr,
  getToolDeclarationsAsJsonStr,
} from './llm_as_judge_utils.js';
export {
  FinalResponseMatchV2EvaluatorMetricInfoProvider,
  HallucinationsV1EvaluatorMetricInfoProvider,
  MultiTurnTaskSuccessV1MetricInfoProvider,
  MultiTurnToolUseQualityV1MetricInfoProvider,
  MultiTurnTrajectoryQualityV1MetricInfoProvider,
  PerTurnUserSimulatorQualityV1MetricInfoProvider,
  ResponseEvaluatorMetricInfoProvider,
  RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider,
  RubricBasedMultiTurnTrajectoryMetricInfoProvider,
  RubricBasedToolUseV1EvaluatorMetricInfoProvider,
  SafetyEvaluatorV1MetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
} from './metric_info_providers.js';
export {MultiTurnTaskSuccessV1Evaluator} from './multi_turn_task_success_evaluator.js';
export type {MultiTurnTaskSuccessV1EvaluatorOptions} from './multi_turn_task_success_evaluator.js';
export {MultiTurnToolUseQualityV1Evaluator} from './multi_turn_tool_use_quality_evaluator.js';
export type {MultiTurnToolUseQualityV1EvaluatorOptions} from './multi_turn_tool_use_quality_evaluator.js';
export {MultiTurnTrajectoryQualityV1Evaluator} from './multi_turn_trajectory_quality_evaluator.js';
export type {MultiTurnTrajectoryQualityV1EvaluatorOptions} from './multi_turn_trajectory_quality_evaluator.js';
export {ResponseEvaluator} from './response_evaluator.js';
export type {ResponseEvaluatorOptions} from './response_evaluator.js';
export {rouge1Score, tokenizeForRouge} from './rouge_scorer.js';
export type {RougeScore} from './rouge_scorer.js';
export {
  DefaultAutoRaterResponseParser,
  MajorityVotePerInvocationResultsAggregator,
  MeanInvocationResultsSummarizer,
  RubricBasedEvaluator,
} from './rubric_based_evaluator.js';
export type {
  AutoRaterResponseParser,
  InvocationResultsSummarizer,
  PerInvocationResultsAggregator,
  RubricBasedEvaluatorOptions,
  RubricResponse,
} from './rubric_based_evaluator.js';
export {RubricBasedFinalResponseQualityV1Evaluator} from './rubric_based_final_response_quality_v1.js';
export {RubricBasedToolUseV1Evaluator} from './rubric_based_tool_use_quality_v1.js';
export {SafetyEvaluatorV1} from './safety_evaluator.js';
export type {SafetyEvaluatorV1Options} from './safety_evaluator.js';
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
