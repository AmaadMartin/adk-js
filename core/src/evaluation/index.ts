/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the
 * `rubric_based_final_response_quality_v1` metric, the rubric base and judge
 * base it stands on, and the contract every metric implements.
 */

export {getDeveloperInstructions, getToolsByAgentName} from './app_details.js';
export type {AgentDetails, AppDetails} from './app_details.js';
export {getAllToolCallsWithResponses, isInvocationEvents} from './eval_case.js';
export type {
  IntermediateData,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  InvocationEvents,
  ToolCallAndResponse,
} from './eval_case.js';
export {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  EvalStatus,
  PrebuiltMetrics,
  getMetricThreshold,
  parseRubricsBasedCriterion,
} from './eval_metrics.js';
export type {
  BaseCriterion,
  CriterionParser,
  EvalMetric,
  EvalMetricCriterion,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
  ParsedLlmAsAJudgeCriterion,
  ParsedRubricsBasedCriterion,
  ResolvedJudgeModelOptions,
  RubricsBasedCriterion,
  Threshold,
} from './eval_metrics.js';
export type {Rubric, RubricContent, RubricScore} from './eval_rubrics.js';
export {
  emptyEvaluationResult,
  getEvalStatus,
  getTextFromContent,
  validateInvocationLengths,
} from './evaluator.js';
export type {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from './evaluator.js';
export {LlmAsJudge} from './llm_as_judge.js';
export type {AutoRaterScore, LlmAsJudgeOptions} from './llm_as_judge.js';
export {
  formatPromptTemplate,
  getAverageRubricScore,
  getGroundingMetadataAsJsonStr,
  getTextFromInvocation,
  getToolCallsAndResponsesAsJsonStr,
  getToolDeclarationsAsJsonStr,
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
export {RubricBasedFinalResponseQualityV1Evaluator} from './rubric_based_final_response_quality_v1.js';
