/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers the `final_response_match_v2`
 * metric, the judge base it stands on, and the contract every metric
 * implements.
 */

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
  EvalStatus,
  getMetricThreshold,
} from './eval_metrics.js';
export type {
  BaseCriterion,
  EvalMetric,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
  LlmAsAJudgeMetric,
} from './eval_metrics.js';
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
export {
  FinalResponseMatchV2Evaluator,
  formatAutoRaterPrompt,
  parseCritique,
} from './final_response_match_v2.js';
export type {AutoRaterPromptValues} from './final_response_match_v2.js';
export {LlmAsJudge} from './llm_as_judge.js';
export {
  Label,
  PARTIALLY_VALID_LABELS,
  getTextFromInvocation,
} from './llm_as_judge_utils.js';
