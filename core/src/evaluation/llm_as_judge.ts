/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {LLMRegistry} from '../models/registry.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {Invocation} from './eval_case.js';
import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  EvalStatus,
  getMetricThreshold,
  LlmAsAJudgeCriterion,
  LlmAsAJudgeMetric,
} from './eval_metrics.js';
import {
  emptyEvaluationResult,
  EvaluationResult,
  Evaluator,
  getEvalStatus,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';
import {addDefaultRetryOptionsIfNotPresent} from './retry_options_utils.js';

/**
 * A metric that asks a judge model to score an invocation.
 *
 * A subclass writes the judge prompt, reads the judge's answer back as a
 * score, and says how the samples of one invocation and the results of a whole
 * eval case are aggregated. This class drives the sampling: it calls the judge
 * `numSamples` times per invocation, at most `parallelismLimit` calls at once,
 * and degrades an invocation whose judge call failed to
 * {@link EvalStatus.NOT_EVALUATED} rather than failing the run.
 */
@experimental
export abstract class LlmAsJudge implements Evaluator {
  protected readonly criterion: LlmAsAJudgeCriterion;
  protected readonly threshold: number;
  protected readonly judgeModel: BaseLlm;
  private readonly judgeModelConfig?: GenerateContentConfig;
  private readonly numSamples: number;
  private readonly parallelismLimit: number;

  /**
   * @param evalMetric The metric this evaluator scores, and the criterion it
   *   is judged against.
   * @param expectedInvocationsRequired Whether the metric refuses to score
   *   without golden invocations.
   * @param judgeModel The judge model to call. Overrides the model the
   *   criterion names, which the registry would otherwise resolve.
   * @throws {InputValidationError} When the metric carries no criterion, or
   *   the criterion asks for fewer than one sample or fewer than one parallel
   *   call.
   */
  constructor(
    evalMetric: LlmAsAJudgeMetric,
    private readonly expectedInvocationsRequired: boolean,
    judgeModel?: BaseLlm,
  ) {
    if (evalMetric.criterion === undefined) {
      throw new InputValidationError(
        `\`${evalMetric.metricName}\` metric expects a criterion.`,
      );
    }
    this.criterion = evalMetric.criterion;
    this.threshold = getMetricThreshold(evalMetric);

    const judgeModelOptions = this.criterion.judgeModelOptions ?? {};
    this.numSamples = judgeModelOptions.numSamples ?? DEFAULT_JUDGE_NUM_SAMPLES;
    this.parallelismLimit =
      judgeModelOptions.parallelismLimit ?? DEFAULT_JUDGE_PARALLELISM_LIMIT;
    if (this.numSamples < 1) {
      throw new InputValidationError(
        `numSamples must be at least 1; got ${this.numSamples}.`,
      );
    }
    if (this.parallelismLimit < 1) {
      throw new InputValidationError(
        `parallelismLimit must be at least 1; got ${this.parallelismLimit}.`,
      );
    }
    this.judgeModelConfig = judgeModelOptions.judgeModelConfig;
    const judgeModelName = judgeModelOptions.judgeModel ?? DEFAULT_JUDGE_MODEL;
    this.judgeModel = judgeModel ?? LLMRegistry.newLlm(judgeModelName);
  }

  /** Returns the prompt that asks the judge to score this invocation. */
  abstract formatAutoRaterPrompt(
    actual: Invocation,
    expected?: Invocation,
  ): string;

  /**
   * Reads the judge's answer back as a score, which is absent when the answer
   * carried no verdict the metric understands.
   */
  abstract convertAutoRaterResponseToScore(
    autoRaterResponse: LlmResponse,
  ): number | undefined;

  /** Reduces the repeated samples of one invocation to a single result. */
  abstract aggregatePerInvocationSamples(
    perInvocationSamples: PerInvocationResult[],
  ): PerInvocationResult;

  /** Reduces the per-invocation results to the result of the eval case. */
  abstract aggregateInvocationResults(
    perInvocationResults: PerInvocationResult[],
  ): EvaluationResult;

  /**
   * @throws {InputValidationError} When the metric needs golden invocations
   *   and none were supplied, or the two lists have different lengths.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult> {
    if (this.expectedInvocationsRequired && expectedInvocations === undefined) {
      throw new InputValidationError(
        'expectedInvocations is required for this metric.',
      );
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const samples: Array<() => Promise<PerInvocationResult>> = [];
    for (const [index, actual] of actualInvocations.entries()) {
      const expected = expectedInvocations?.[index];
      const llmRequest: LlmRequest = {
        model: this.judgeModel.model,
        contents: [
          {
            role: 'user',
            parts: [{text: this.formatAutoRaterPrompt(actual, expected)}],
          },
        ],
        config: this.judgeModelConfig ?? {},
        liveConnectConfig: {},
        toolsDict: {},
      };
      addDefaultRetryOptionsIfNotPresent(llmRequest);
      for (let sample = 0; sample < this.numSamples; sample++) {
        samples.push(() => this.evaluateSample(llmRequest, actual, expected));
      }
    }

    // The samples of one invocation were scheduled together, so they occupy
    // one `numSamples`-long window of the outcomes.
    const settled = await settleInBatches(samples, this.parallelismLimit);
    const perInvocationResults = actualInvocations.map((actual, index) =>
      this.resolveInvocationResult(
        index,
        actual,
        expectedInvocations?.[index],
        settled.slice(index * this.numSamples, (index + 1) * this.numSamples),
      ),
    );

    if (perInvocationResults.length === 0) {
      return emptyEvaluationResult();
    }
    return this.aggregateInvocationResults(perInvocationResults);
  }

  /**
   * Reduces the outcomes of one invocation's samples to its result. An
   * invocation any of whose judge calls failed counts as not evaluated, so one
   * failed call never fails the whole eval case.
   */
  private resolveInvocationResult(
    index: number,
    actual: Invocation,
    expected: Invocation | undefined,
    outcomes: Array<PromiseSettledResult<PerInvocationResult>>,
  ): PerInvocationResult {
    const samples: PerInvocationResult[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        logger.warn(
          `Evaluation sample failed for invocation ${index}:`,
          outcome.reason,
        );
      } else {
        samples.push(outcome.value);
      }
    }

    if (samples.length < outcomes.length) {
      return {
        actualInvocation: actual,
        expectedInvocation: expected,
        evalStatus: EvalStatus.NOT_EVALUATED,
      };
    }
    return this.aggregatePerInvocationSamples(samples);
  }

  /**
   * Calls the judge once and scores its answer.
   *
   * @throws {Error} When the judge model yields no response at all.
   */
  private async evaluateSample(
    llmRequest: LlmRequest,
    actual: Invocation,
    expected?: Invocation,
  ): Promise<PerInvocationResult> {
    for await (const llmResponse of this.judgeModel.generateContentAsync(
      llmRequest,
      false,
    )) {
      const score = this.convertAutoRaterResponseToScore(llmResponse);
      return {
        actualInvocation: actual,
        expectedInvocation: expected,
        score,
        evalStatus: getEvalStatus(score, this.threshold),
      };
    }
    throw new Error(
      'LLM evaluation failed: no response received from judge model',
    );
  }
}

/**
 * Runs the tasks in batches, so that no more than `limit` of them are in
 * flight at once, and returns every outcome in the order the tasks were given.
 */
async function settleInBatches<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<PromiseSettledResult<T>>> {
  const settled: Array<PromiseSettledResult<T>> = [];
  for (let start = 0; start < tasks.length; start += limit) {
    settled.push(
      ...(await Promise.allSettled(
        tasks.slice(start, start + limit).map((task) => task()),
      )),
    );
  }
  return settled;
}
