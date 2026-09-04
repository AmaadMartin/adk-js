/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import type {ConversationScenario} from '../conversation_scenarios.js';
import type {Invocation} from '../eval_case.js';
import type {EvalMetric} from '../eval_metrics.js';
import {
  EvalStatus,
  getMetricThreshold,
  parseLlmBackedUserSimulatorCriterion,
} from '../eval_metrics.js';
import type {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from '../evaluator.js';
import {
  emptyEvaluationResult,
  getEvalStatus,
  getTextFromContent,
} from '../evaluator.js';
import type {AutoRaterScore} from '../llm_as_judge.js';
import {Label, PARTIALLY_VALID_LABELS} from '../llm_as_judge_utils.js';
import {addDefaultRetryOptionsIfNotPresent} from '../retry_options_utils.js';
import {getPerTurnUserSimulatorQualityPrompt} from './per_turn_user_simulator_quality_prompts.js';

/** The criterion type this metric accepts, named in its rejection message. */
const CRITERION_TYPE_NAME = 'LlmBackedUserSimulatorCriterion';

/** The invocation id given to the synthetic stop-signal turn. */
const STOP_SIGNAL_INVOCATION_ID = 'stop_signal_proxy_invocation';

/** The author reported for a response whose content names no role. */
const DEFAULT_RESPONSE_ROLE = 'model';

/** Matches the `is_valid` field of a judge critique. */
const IS_VALID_PATTERN =
  /"is_valid":\s*\[*[\n\s]*"*([^"\]]*)"*[\n\s]*\]*\s*[,\n}]/;

/** The label spellings that mark a simulated turn invalid. */
const INVALID_LABELS: ReadonlySet<string> = new Set([
  Label.INVALID,
  Label.ALMOST,
  Label.FALSE,
  ...PARTIALLY_VALID_LABELS,
]);

/** The label spellings that mark a simulated turn valid. */
const VALID_LABELS: ReadonlySet<string> = new Set([Label.VALID, Label.TRUE]);

/**
 * Reads the `is_valid` verdict out of a judge critique.
 *
 * adk-python's `_parse_llm_response`. The pattern carries no `g` flag, so
 * repeated calls cannot leak a match position between them.
 */
export function parseIsValidLabel(response: string): Label {
  const match = IS_VALID_PATTERN.exec(response);
  if (match === null) {
    return Label.NOT_FOUND;
  }

  const label = match[1]
    .replace(/^\}+|\}+$/g, '')
    .replaceAll(',', '')
    .trim()
    .toLowerCase();
  if (INVALID_LABELS.has(label)) {
    return Label.INVALID;
  }
  if (VALID_LABELS.has(label)) {
    return Label.VALID;
  }
  return Label.NOT_FOUND;
}

/**
 * Renders a conversation as the alternating transcript the judge reads.
 *
 * adk-python's `_format_conversation_history`.
 */
export function formatConversationHistory(invocations: Invocation[]): string {
  const lines: string[] = [];
  for (const invocation of invocations) {
    if (invocation.userContent.parts?.length) {
      lines.push(`user: ${getTextFromContent(invocation.userContent)}`);
    }

    const finalResponse = invocation.finalResponse;
    if (finalResponse !== undefined) {
      const role = finalResponse.role ?? DEFAULT_RESPONSE_ROLE;
      lines.push(`${role}: ${getTextFromContent(finalResponse)}`);
    }
  }
  return lines.join('\n\n');
}

/**
 * Builds the judge prompt for one simulated user turn.
 *
 * adk-python's `PerTurnUserSimulatorQualityV1._format_llm_prompt`. Its two
 * `None` guards are dropped: both parameters are required here, so the caller
 * cannot omit them. `evaluateInvocations` rejects a missing scenario at the
 * boundary a caller can actually reach.
 */
export function formatJudgePrompt(params: {
  invocation: Invocation;
  conversationScenario: ConversationScenario;
  previousInvocations: Invocation[];
  stopSignal: string;
}): string {
  const {invocation, conversationScenario, previousInvocations, stopSignal} =
    params;
  return getPerTurnUserSimulatorQualityPrompt({
    conversationPlan: conversationScenario.conversationPlan,
    conversationHistory: formatConversationHistory(previousInvocations),
    generatedUserResponse: getTextFromContent(invocation.userContent),
    stopSignal,
    userPersona: conversationScenario.userPersona,
  });
}

/**
 * Scores a judge critique: 1 for a valid turn, 0 for an invalid one, and no
 * score when the critique carries no verdict.
 *
 * adk-python's `_convert_llm_response_to_score`.
 */
export function convertLlmResponseToScore(
  autoRaterResponse: LlmResponse,
): AutoRaterScore {
  const responseText = getTextFromContent(autoRaterResponse.content);
  if (!responseText) {
    return {};
  }

  switch (parseIsValidLabel(responseText)) {
    case Label.VALID:
      return {score: 1.0};
    case Label.INVALID:
      return {score: 0.0};
    default:
      return {};
  }
}

/**
 * Folds the repeated samples of one turn into a single result by majority
 * vote. A tie counts as invalid.
 *
 * adk-python's `_aggregate_samples`.
 *
 * @throws {Error} When there are no samples.
 */
export function aggregateSamples(
  samples: PerInvocationResult[],
): PerInvocationResult {
  if (samples.length === 0) {
    throw new Error('No samples to aggregate into a result.');
  }

  const positives = samples.filter((sample) => sample.score === 1.0);
  const negatives = samples.filter((sample) => sample.score === 0.0);
  if (positives.length === 0 && negatives.length === 0) {
    return samples[0];
  }
  return positives.length > negatives.length ? positives[0] : negatives[0];
}

/**
 * Scores the first turn by comparing it against the scenario's starting
 * prompt, which the simulator is required to reproduce.
 *
 * adk-python's `_evaluate_first_turn`.
 */
export function evaluateFirstTurn(
  firstInvocation: Invocation,
  conversationScenario: ConversationScenario,
  threshold: number,
): PerInvocationResult {
  const userText = getTextFromContent(firstInvocation.userContent);
  if (!userText) {
    return {
      actualInvocation: firstInvocation,
      evalStatus: EvalStatus.NOT_EVALUATED,
    };
  }

  const score =
    userText.trim() === conversationScenario.startingPrompt.trim() ? 1 : 0;
  return {
    actualInvocation: firstInvocation,
    score,
    evalStatus: getEvalStatus(score, threshold),
  };
}

/**
 * Folds the per-turn results into the fraction of the conversation the judge
 * accepted.
 *
 * adk-python's `_aggregate_conversation_results`. It sums the scores of the
 * results that passed rather than counting them, so a turn that passed with a
 * score of 0 contributes nothing.
 */
export function aggregateConversationResults(
  results: PerInvocationResult[],
  threshold: number,
): EvaluationResult {
  if (results.length === 0) {
    return {
      perInvocationResults: results,
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
    };
  }

  let numValid = 0;
  for (const result of results) {
    if (result.evalStatus === EvalStatus.PASSED && result.score !== undefined) {
      numValid += result.score;
    }
  }

  const overallScore = numValid / results.length;
  return {
    overallScore,
    overallEvalStatus: getEvalStatus(overallScore, threshold),
    perInvocationResults: results,
  };
}

/** Options for {@link PerTurnUserSimulatorQualityV1}. */
export interface PerTurnUserSimulatorQualityV1Options {
  /**
   * The judge model to grade with. Resolved from `LLMRegistry` when absent.
   */
  judgeModel?: BaseLlm;
}

/**
 * Grades a simulated user against the scenario it was given, turn by turn.
 *
 * It checks that the first turn is the scenario's starting prompt, that every
 * later turn keeps to the conversation plan, and that the conversation stopped
 * when it should have. A judge model grades every turn except the first, and
 * the repeated samples of one turn are folded by majority vote. The overall
 * score is the fraction of turns the judge accepted.
 */
@experimental
export class PerTurnUserSimulatorQualityV1 implements Evaluator {
  private readonly threshold: number;
  private readonly stopSignal: string;
  private readonly numSamples: number;
  private readonly judgeModelConfig: GenerateContentConfig;
  private readonly judgeModel: BaseLlm;

  constructor(
    evalMetric: EvalMetric,
    options?: PerTurnUserSimulatorQualityV1Options,
  ) {
    const {judgeModelOptions, stopSignal} = deserializeCriterion(evalMetric);
    this.threshold = getMetricThreshold(evalMetric);
    this.stopSignal = stopSignal;
    this.numSamples = judgeModelOptions.numSamples;
    this.judgeModelConfig = judgeModelOptions.judgeModelConfig ?? {};
    this.judgeModel =
      options?.judgeModel ?? LLMRegistry.newLlm(judgeModelOptions.judgeModel);
  }

  /**
   * Grades every turn of a simulated conversation.
   *
   * @param actualInvocations The conversation the simulated user drove.
   * @param expectedInvocations Ignored: this metric grades the simulator
   *   against its scenario, not against a golden conversation.
   * @param conversationScenario The scenario the simulated user was given.
   * @throws {InputValidationError} When `conversationScenario` is absent.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    if (conversationScenario === undefined) {
      throw new InputValidationError(
        'conversationScenario is needed by this metric.',
      );
    }
    if (actualInvocations.length === 0) {
      return emptyEvaluationResult();
    }

    const results = [
      evaluateFirstTurn(
        actualInvocations[0],
        conversationScenario,
        this.threshold,
      ),
    ];
    for (let index = 1; index < actualInvocations.length; index++) {
      results.push(
        await this.evaluateIntermediateTurn(
          actualInvocations[index],
          actualInvocations.slice(0, index),
          conversationScenario,
        ),
      );
    }

    const stopSignalResult = await this.evaluateIntermediateTurn(
      {
        invocationId: STOP_SIGNAL_INVOCATION_ID,
        userContent: {parts: [{text: this.stopSignal}]},
      },
      actualInvocations,
      conversationScenario,
    );
    if (stopSignalResult.evalStatus === EvalStatus.FAILED) {
      results[results.length - 1] = stopSignalResult;
    }

    return aggregateConversationResults(results, this.threshold);
  }

  /** Asks the judge model to grade one turn, and folds its samples. */
  private async evaluateIntermediateTurn(
    invocationAtStep: Invocation,
    invocationHistory: Invocation[],
    conversationScenario: ConversationScenario,
  ): Promise<PerInvocationResult> {
    const llmRequest: LlmRequest = {
      model: this.judgeModel.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: formatJudgePrompt({
                invocation: invocationAtStep,
                conversationScenario,
                previousInvocations: invocationHistory,
                stopSignal: this.stopSignal,
              }),
            },
          ],
        },
      ],
      config: this.judgeModelConfig,
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    const samples: PerInvocationResult[] = [];
    for (let sample = 0; sample < this.numSamples; sample++) {
      const {score} = await this.sampleJudge(llmRequest);
      samples.push({
        actualInvocation: invocationAtStep,
        score,
        evalStatus: getEvalStatus(score, this.threshold),
      });
    }
    if (samples.length === 0) {
      return {
        actualInvocation: invocationAtStep,
        evalStatus: EvalStatus.NOT_EVALUATED,
      };
    }
    return aggregateSamples(samples);
  }

  /**
   * Runs one judge call. The call is not streamed, so the first response is
   * the whole critique and returning closes the generator. A judge that
   * answers nothing scores nothing, matching adk-python.
   */
  private async sampleJudge(llmRequest: LlmRequest): Promise<AutoRaterScore> {
    for await (const llmResponse of this.judgeModel.generateContentAsync(
      llmRequest,
    )) {
      return convertLlmResponseToScore(llmResponse);
    }
    return {};
  }
}

/**
 * Validates the metric's criterion.
 *
 * @throws {InputValidationError} When the metric names no criterion, or names
 *   one this metric cannot read.
 */
function deserializeCriterion(evalMetric: EvalMetric) {
  const message =
    `\`${evalMetric.metricName}\` metric expects a criterion of type ` +
    `\`${CRITERION_TYPE_NAME}\`.`;
  if (evalMetric.criterion === undefined) {
    throw new InputValidationError(message);
  }

  try {
    return parseLlmBackedUserSimulatorCriterion(evalMetric.criterion);
  } catch (error: unknown) {
    throw new InputValidationError(message, {cause: error});
  }
}
