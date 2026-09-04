/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the `LlmAsJudge` base class and
 * the `RubricBasedEvaluator` base class that rubric metrics stand on.
 *
 * The exports are what an author of a rubric metric needs, plus the types those
 * signatures reference. A symbol that belongs to a metric this package does not
 * ship yet stays internal until that metric lands.
 */

export type {AgentDetails, AppDetails} from './app_details.js';
export type {ConversationScenario} from './conversation_scenarios.js';
export type {
  IntermediateData,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  InvocationEvents,
} from './eval_case.js';
export {
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  EvalStatus,
  PrebuiltMetrics,
  ToolTrajectoryMatchType,
  getMetricThreshold,
  normalizeToolTrajectoryMatchType,
  parseRubricsBasedCriterion,
  resolveJudgeModelOptions,
} from './eval_metrics.js';
export type {
  BaseCriterion,
  CriterionParser,
  EvalMetric,
  EvalMetricCriterion,
  HallucinationsCriterion,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
  LlmBackedUserSimulatorCriterion,
  ResolvedJudgeModelOptions,
  RubricsBasedCriterion,
  ToolTrajectoryCriterion,
} from './eval_metrics.js';
export type {Rubric, RubricContent, RubricScore} from './eval_rubrics.js';
export {getEvalStatus, getTextFromContent} from './evaluator.js';
export type {
  CriterionType,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from './evaluator.js';
export {LlmAsJudge} from './llm_as_judge.js';
export type {AutoRaterScore, LlmAsJudgeOptions} from './llm_as_judge.js';
export {getAverageRubricScore} from './llm_as_judge_utils.js';
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
