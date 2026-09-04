/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the eval case data model, the
 * contract every metric evaluator implements, the `LlmAsJudge` base class, and
 * the `RubricBasedEvaluator` base class that rubric metrics stand on.
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
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  EvalStatus,
  PrebuiltMetrics,
  getMetricThreshold,
  parseLlmAsAJudgeCriterion,
  parseRubricsBasedCriterion,
} from './eval_metrics.js';
export type {
  BaseCriterion,
  CriterionParser,
  EvalMetric,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
  LlmAsAJudgeMetric,
  ResolvedJudgeModelOptions,
  RubricsBasedCriterion,
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
export {LlmAsJudge} from './llm_as_judge.js';
export type {AutoRaterScore, LlmAsJudgeOptions} from './llm_as_judge.js';
export {
  Label,
  PARTIALLY_VALID_LABELS,
  getAverageRubricScore,
  getTextFromInvocation,
} from './llm_as_judge_utils.js';
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
export type {
  UserBehavior,
  UserPersona,
} from './simulation/user_simulator_personas.js';
