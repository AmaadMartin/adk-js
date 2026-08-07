/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {LLMRegistry} from '../models/registry.js';
import {experimental} from '../utils/experimental.js';

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {
  EvalMetric,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
} from './eval_metrics.js';
import {RubricScore} from './eval_rubrics.js';
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';
import {getEvalStatus} from './llm_as_judge_utils.js';
import {addDefaultRetryOptionsIfNotPresent} from './retry_options_utils.js';

/**
 * A score produced by an auto-rater for a single invocation sample.
 */
export interface AutoRaterScore {
  /** The overall score, if one could be determined. */
  score?: number;
  /** Per-rubric scores, when the auto-rater is rubric based. */
  rubricScores?: RubricScore[];
}

/**
 * Evaluator backed by an LLM ("auto-rater").
 *
 * It is meant to be extended by specific auto-raters for different evaluation
 * tasks:
 *   - Provide the prompt template and implement {@link formatAutoRaterPrompt} to
 *     format the auto-rater prompt for a given invocation.
 *   - Implement {@link convertAutoRaterResponseToScore} to parse the auto-rater
 *     response and return the corresponding score.
 *   - Implement {@link aggregateInvocationResults} to aggregate the
 *     per-invocation results into the overall score.
 *   - (Optional) Override {@link aggregatePerInvocationSamples} to aggregate
 *     multiple auto-rater samples of the same invocation.
 */
@experimental
export abstract class LlmAsJudge<
  C extends LlmAsAJudgeCriterion = LlmAsAJudgeCriterion,
> extends Evaluator {
  protected readonly criterion: C;
  protected readonly judgeModelOptions: JudgeModelOptions;
  protected readonly judgeModel: BaseLlm;
  /** Resolved numeric threshold used to derive per-sample eval status. */
  protected readonly threshold: number;
  private readonly expectedInvocationsRequired: boolean;

  constructor(
    evalMetric: EvalMetric,
    criterionSchema: z.ZodType<C>,
    criterionTypeName: string,
    expectedInvocationsRequired = false,
  ) {
    super();
    this.expectedInvocationsRequired = expectedInvocationsRequired;

    const expectedCriterionTypeError = new Error(
      `\`${evalMetric.metricName}\` metric expects a criterion of type ` +
        `\`${criterionTypeName}\`.`,
    );
    if (!evalMetric.criterion) {
      throw expectedCriterionTypeError;
    }
    const parsedCriterion = criterionSchema.safeParse(evalMetric.criterion);
    if (!parsedCriterion.success) {
      throw expectedCriterionTypeError;
    }

    this.criterion = parsedCriterion.data;
    this.judgeModelOptions = this.criterion.judgeModelOptions;
    this.threshold = evalMetric.threshold ?? this.criterion.threshold;
    this.judgeModel = this.setupAutoRater();
  }

  /** Resolves and instantiates the judge model from the registry. */
  protected setupAutoRater(): BaseLlm {
    return LLMRegistry.newLlm(this.judgeModelOptions.judgeModel);
  }

  /** Formats the auto-rater prompt to evaluate the given invocation. */
  abstract formatAutoRaterPrompt(
    actual: Invocation,
    expected?: Invocation,
  ): string;

  /**
   * Parses an auto-rater response and returns the corresponding score, or an
   * empty score if it cannot be determined.
   */
  abstract convertAutoRaterResponseToScore(
    autoRaterResponse: LlmResponse,
  ): AutoRaterScore;

  /**
   * Aggregates repeated per-invocation samples into the final result for the
   * invocation.
   */
  abstract aggregatePerInvocationSamples(
    perInvocationSamples: PerInvocationResult[],
  ): PerInvocationResult;

  /** Aggregates the per-invocation results into the overall result. */
  abstract aggregateInvocationResults(
    perInvocationResults: PerInvocationResult[],
  ): EvaluationResult;

  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    if (this.expectedInvocationsRequired && expectedInvocations === undefined) {
      throw new Error('expectedInvocations is needed by this metric.');
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);
    // conversationScenario is not supported for per-invocation evaluation.
    void conversationScenario;

    // If expected invocations are not required by the metric and are not
    // supplied, we provide a list of undefined.
    const expected: Array<Invocation | undefined> =
      expectedInvocations ?? actualInvocations.map(() => undefined);

    const perInvocationResults: PerInvocationResult[] = [];
    for (let i = 0; i < actualInvocations.length; i++) {
      const actual = actualInvocations[i];
      const expectedInvocation = expected[i];
      const autoRaterPrompt = this.formatAutoRaterPrompt(
        actual,
        expectedInvocation,
      );
      const llmRequest: LlmRequest = {
        model: this.judgeModelOptions.judgeModel,
        contents: [{role: 'user', parts: [{text: autoRaterPrompt}]}],
        config: this.judgeModelOptions.judgeModelConfig ?? {},
        liveConnectConfig: {},
        toolsDict: {},
      };
      addDefaultRetryOptionsIfNotPresent(llmRequest);

      const invocationResultSamples: PerInvocationResult[] = [];
      for (
        let sample = 0;
        sample < this.judgeModelOptions.numSamples;
        sample++
      ) {
        // Non-streaming call, so there is only one response content.
        for await (const llmResponse of this.judgeModel.generateContentAsync(
          llmRequest,
          false,
        )) {
          const autoRaterScore =
            this.convertAutoRaterResponseToScore(llmResponse);
          invocationResultSamples.push({
            actualInvocation: actual,
            expectedInvocation,
            score: autoRaterScore.score,
            evalStatus: getEvalStatus(autoRaterScore.score, this.threshold),
            rubricScores: autoRaterScore.rubricScores,
          });
        }
      }
      if (invocationResultSamples.length === 0) {
        continue;
      }
      perInvocationResults.push(
        this.aggregatePerInvocationSamples(invocationResultSamples),
      );
    }

    if (perInvocationResults.length > 0) {
      return this.aggregateInvocationResults(perInvocationResults);
    }
    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    };
  }
}
