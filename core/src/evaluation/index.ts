/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK evaluation module (a parity port of `google/adk-python`'s
 * `google/adk/evaluation`). It currently covers `LlmAsJudge` and the
 * substrate that evaluator stands on.
 */

export type {Invocation} from './eval_case.js';
export {
  DEFAULT_JUDGE_MODEL,
  EvalStatus,
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
  RubricsBasedCriterion,
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
