/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {LLMRegistry} from '../models/registry.js';
import {mapWithConcurrency} from '../utils/concurrency_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {Invocation} from './eval_case.js';
import {
  CriterionParser,
  EvalMetric,
  EvalStatus,
  ParsedLlmAsAJudgeCriterion,
  getMetricThreshold,
} from './eval_metrics.js';
import {RubricScore} from './eval_rubrics.js';
import {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  emptyEvaluationResult,
  getEvalStatus,
  validateInvocationLengths,
} from './evaluator.js';
import {addDefaultRetryOptionsIfNotPresent} from './retry_options_utils.js';

/** A score an auto-rater produced for one sample of one invocation. */
export interface AutoRaterScore {
  /** The overall score. Absent when it could not be determined. */
  score?: number;

  /** Per-rubric scores, when the auto-rater is rubric based. */
  rubricScores?: RubricScore[];
}

/** How a {@link LlmAsJudge} is configured. */
export interface LlmAsJudgeOptions<
  CriterionT extends ParsedLlmAsAJudgeCriterion,
> {
  evalMetric: EvalMetric;

  /**
   * Validates the metric's criterion, e.g. `parseLlmAsAJudgeCriterion`.
   */
  parseCriterion: CriterionParser<CriterionT>;

  /**
   * The judge model to grade with. Resolved from `LLMRegistry` when absent.
   * Supply one to grade against a model the registry does not own.
   */
  judgeModel?: BaseLlm;
}

/** One judge call: one sample of one invocation. */
interface JudgeSample {
  invocationIndex: number;

  /** Shared by every sample of the same invocation. */
  llmRequest: LlmRequest;

  actual: Invocation;

  expected?: Invocation;
}

/** The samples of one invocation, once they have all settled. */
interface SettledInvocation {
  results: PerInvocationResult[];

  /** True when at least one sample of this invocation failed. */
  failed: boolean;
}

/**
 * Validates the criterion of a metric, reporting the type it expects.
 *
 * @throws {InputValidationError} When the metric carries no criterion, or one
 *   the parser rejects.
 */
function parseMetricCriterion<CriterionT extends ParsedLlmAsAJudgeCriterion>(
  evalMetric: EvalMetric,
  parseCriterion: CriterionParser<CriterionT>,
): CriterionT {
  const message =
    `\`${evalMetric.metricName}\` metric expects a criterion of type ` +
    `\`${parseCriterion.criterionName}\`.`;

  if (evalMetric.criterion === undefined) {
    throw new InputValidationError(message);
  }
  try {
    return parseCriterion(evalMetric.criterion);
  } catch (error) {
    throw new InputValidationError(message, {cause: error});
  }
}

/**
 * Groups settled samples by the invocation they belong to, and reports every
 * failed sample.
 *
 * An invocation that has no samples gets no entry.
 */
function groupSettledSamples(
  samples: readonly JudgeSample[],
  settled: ReadonlyArray<PromiseSettledResult<PerInvocationResult>>,
): Map<number, SettledInvocation> {
  const byInvocation = new Map<number, SettledInvocation>();

  for (const [sampleIndex, outcome] of settled.entries()) {
    const {invocationIndex} = samples[sampleIndex];
    const invocation = byInvocation.get(invocationIndex) ?? {
      results: [],
      failed: false,
    };
    if (outcome.status === 'rejected') {
      invocation.failed = true;
      logger.warn(
        `Evaluation sample failed for invocation ${invocationIndex}: ${outcome.reason}`,
      );
    } else {
      invocation.results.push(outcome.value);
    }
    byInvocation.set(invocationIndex, invocation);
  }

  return byInvocation;
}

/**
 * An evaluator that grades invocations with a judge model.
 *
 * A concrete metric extends it and supplies four behaviours: the prompt for
 * one invocation, how to read a score out of one judge response, how to fold
 * the repeated samples of one invocation into a single result, and how to
 * fold the per-invocation results into an overall one. This class owns
 * everything else, including sampling, bounded parallelism and the failure
 * semantics of a sample that does not come back.
 */
@experimental
export abstract class LlmAsJudge<
  CriterionT extends ParsedLlmAsAJudgeCriterion,
> implements Evaluator {
  protected readonly criterion: CriterionT;

  protected readonly threshold: number;
  protected readonly judgeModel: BaseLlm;

  constructor(options: LlmAsJudgeOptions<CriterionT>) {
    this.criterion = parseMetricCriterion(
      options.evalMetric,
      options.parseCriterion,
    );
    this.threshold = getMetricThreshold(options.evalMetric);
    this.judgeModel =
      options.judgeModel ??
      LLMRegistry.newLlm(this.criterion.judgeModelOptions.judgeModel);
  }

  /** Formats the auto-rater prompt that grades the given invocation. */
  abstract formatAutoRaterPrompt(
    actual: Invocation,
    expected?: Invocation,
  ): string;

  /**
   * Reads the score out of one auto-rater response. Returns a score of
   * `undefined` when the response does not determine one.
   */
  abstract convertAutoRaterResponseToScore(
    autoRaterResponse: LlmResponse,
  ): AutoRaterScore;

  /** Folds the repeated samples of one invocation into a single result. */
  abstract aggregatePerInvocationSamples(
    perInvocationSamples: PerInvocationResult[],
  ): PerInvocationResult;

  /** Folds the per-invocation results into the overall result. */
  abstract aggregateInvocationResults(
    perInvocationResults: PerInvocationResult[],
  ): EvaluationResult;

  /**
   * Grades every actual invocation, optionally against a golden one.
   *
   * Every sample of every invocation shares one parallelism budget, so at
   * most `criterion.judgeModelOptions.parallelismLimit` judge calls are ever in flight.
   * A sample that fails is logged and marks its own invocation
   * `NOT_EVALUATED`; the other invocations are graded as usual.
   *
   * @throws {InputValidationError} When the two lists have different lengths.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult> {
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const samples = this.buildSamples(actualInvocations, expectedInvocations);
    const settled = await mapWithConcurrency(
      samples,
      this.criterion.judgeModelOptions.parallelismLimit,
      (sample) => this.evaluateSingleSample(sample),
    );
    const byInvocation = groupSettledSamples(samples, settled);

    const perInvocationResults: PerInvocationResult[] = [];
    for (const [invocationIndex, actual] of actualInvocations.entries()) {
      const invocation = byInvocation.get(invocationIndex);
      if (invocation === undefined) {
        continue;
      }
      perInvocationResults.push(
        invocation.failed
          ? {
              actualInvocation: actual,
              expectedInvocation: expectedInvocations?.[invocationIndex],
              evalStatus: EvalStatus.NOT_EVALUATED,
            }
          : this.aggregatePerInvocationSamples(invocation.results),
      );
    }

    if (perInvocationResults.length === 0) {
      return emptyEvaluationResult();
    }
    return this.aggregateInvocationResults(perInvocationResults);
  }

  /**
   * Builds one judge call per sample, ordered by invocation.
   *
   * The prompt is formatted once per invocation and shared by that
   * invocation's samples, so repeated sampling asks the same question.
   */
  private buildSamples(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): JudgeSample[] {
    const samples: JudgeSample[] = [];

    for (const [invocationIndex, actual] of actualInvocations.entries()) {
      const expected = expectedInvocations?.[invocationIndex];
      const llmRequest: LlmRequest = {
        // The model that answers, not the one the criterion names: `Gemini`
        // binds the outgoing call to `llmRequest.model` ahead of its own, so a
        // caller-supplied judge would otherwise be sent to the wrong model.
        model: this.judgeModel.model,
        contents: [
          {
            role: 'user',
            parts: [{text: this.formatAutoRaterPrompt(actual, expected)}],
          },
        ],
        config: this.criterion.judgeModelOptions.judgeModelConfig ?? {},
        liveConnectConfig: {},
        toolsDict: {},
      };
      addDefaultRetryOptionsIfNotPresent(llmRequest);

      for (
        let sample = 0;
        sample < this.criterion.judgeModelOptions.numSamples;
        sample++
      ) {
        samples.push({invocationIndex, llmRequest, actual, expected});
      }
    }

    return samples;
  }

  /**
   * Grades one sample.
   *
   * @throws {Error} When the judge model yields no response.
   */
  private async evaluateSingleSample(
    sample: JudgeSample,
  ): Promise<PerInvocationResult> {
    // The call is non-streaming, so the first response is the whole answer.
    // Returning out of the loop closes the generator.
    for await (const llmResponse of this.judgeModel.generateContentAsync(
      sample.llmRequest,
    )) {
      const autoRaterScore = this.convertAutoRaterResponseToScore(llmResponse);
      return {
        actualInvocation: sample.actual,
        expectedInvocation: sample.expected,
        score: autoRaterScore.score,
        evalStatus: getEvalStatus(autoRaterScore.score, this.threshold),
        rubricScores: autoRaterScore.rubricScores,
      };
    }

    throw new Error(
      'LLM evaluation failed: no response received from judge model',
    );
  }
}
