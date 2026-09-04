/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../../errors/input_validation_error.js';
import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import {ConversationScenario, Invocation} from '../eval_case.js';
import {
  EvalMetric,
  EvalStatus,
  ParsedLlmBackedUserSimulatorCriterion,
  ResolvedJudgeModelOptions,
  parseLlmBackedUserSimulatorCriterion,
} from '../eval_metrics.js';
import {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  emptyEvaluationResult,
  getEvalStatus,
  getTextFromContent,
} from '../evaluator.js';
import type {AutoRaterScore} from '../llm_as_judge.js';
import {Label, PARTIALLY_VALID_LABELS} from '../llm_as_judge_utils.js';
import {addDefaultRetryOptionsIfNotPresent} from '../retry_options_utils.js';
import {getPerTurnUserSimulatorQualityPrompt} from './per_turn_user_simulator_quality_prompts.js';

/** Matches the `is_valid` field of a judge critique, however it is spelled. */
const IS_VALID_PATTERN =
  /"is_valid":\s*\[*[\n\s]*"*([^"\]]*)"*[\n\s]*\]*\s*[,\n}]/;

/** The spellings that mark a simulated user turn invalid. */
const INVALID_LABELS: ReadonlySet<string> = new Set<string>([
  Label.INVALID,
  Label.ALMOST,
  Label.FALSE,
  ...PARTIALLY_VALID_LABELS,
]);

/** The spellings that mark a simulated user turn valid. */
const VALID_LABELS: ReadonlySet<string> = new Set<string>([
  Label.VALID,
  Label.TRUE,
]);

/** The criterion type this metric accepts, named in the error that rejects one. */
const CRITERION_TYPE_NAME = 'LlmBackedUserSimulatorCriterion';

/** The invocation id of the turn that asks whether the conversation ended. */
const STOP_SIGNAL_INVOCATION_ID = 'stop_signal_proxy_invocation';

/** The role reported for an agent reply that names none. */
const DEFAULT_RESPONSE_ROLE = 'model';

/**
 * Reads the `is_valid` verdict out of a judge critique.
 *
 * @param response The critique text the judge model wrote.
 * @returns The verdict, which is {@link Label.NOT_FOUND} when the critique
 *   names no `is_valid` field or names a value this metric does not know.
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
 * A turn contributes a `user:` line when its user content holds parts, and a
 * line named after the agent reply's role when it holds one. adk-python writes
 * the literal `None` for a reply that names no role; this writes
 * `{@link DEFAULT_RESPONSE_ROLE}`.
 *
 * @param invocations The turns to render, in order.
 * @returns The transcript, one line per message, blank line separated.
 */
export function formatConversationHistory(invocations: Invocation[]): string {
  const lines: string[] = [];
  for (const invocation of invocations) {
    if ((invocation.userContent.parts ?? []).length > 0) {
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
 * Renders the judge prompt that grades one simulated user turn.
 *
 * @param params.invocation The turn under judgement.
 * @param params.conversationScenario The scenario the simulator was driving.
 * @param params.previousInvocations The turns that came before this one.
 * @param params.stopSignal The text that marks the conversation complete.
 * @returns The rendered prompt.
 * @throws {InputValidationError} When the previous turns or the scenario are
 *   absent.
 */
export function formatPerTurnUserSimulatorPrompt(params: {
  invocation: Invocation;
  conversationScenario?: ConversationScenario;
  previousInvocations?: Invocation[];
  stopSignal: string;
}): string {
  if (params.previousInvocations === undefined) {
    throw new InputValidationError(
      'Previous invocations should have a set value when formatting the LLM' +
        ' prompt.',
    );
  }
  if (params.conversationScenario === undefined) {
    throw new InputValidationError(
      'Conversation scenario should have a set value when formatting the LLM' +
        ' prompt.',
    );
  }

  return getPerTurnUserSimulatorQualityPrompt({
    conversationPlan: params.conversationScenario.conversationPlan,
    conversationHistory: formatConversationHistory(params.previousInvocations),
    generatedUserResponse: getTextFromContent(params.invocation.userContent),
    stopSignal: params.stopSignal,
    userPersona: params.conversationScenario.userPersona,
  });
}

/**
 * Scores one judge critique: 1 for a valid turn, 0 for an invalid one.
 *
 * @param autoRaterResponse The judge model's answer.
 * @returns The score, which is absent when the critique determines none.
 */
export function convertLlmResponseToScore(
  autoRaterResponse: LlmResponse,
): AutoRaterScore {
  const responseText = getTextFromContent(autoRaterResponse.content);
  if (responseText === '') {
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
 * Folds the repeated samples of one turn into a single result, by majority
 * vote. A tie counts as invalid, so a judge that cannot make up its mind does
 * not pass a turn.
 *
 * @param samples The samples of one turn, in the order they were taken.
 * @returns The winning sample. The first sample wins when no sample scored.
 * @throws {InputValidationError} When there are no samples.
 */
export function aggregateSamples(
  samples: PerInvocationResult[],
): PerInvocationResult {
  if (samples.length === 0) {
    throw new InputValidationError('No samples to aggregate into a result.');
  }

  const positives = samples.filter((sample) => sample.score === 1.0);
  const negatives = samples.filter((sample) => sample.score === 0.0);
  if (positives.length === 0 && negatives.length === 0) {
    return samples[0];
  }
  return positives.length > negatives.length ? positives[0] : negatives[0];
}

/**
 * Grades the first turn, which must repeat the scenario's starting prompt.
 *
 * The judge model has no say here: the starting prompt is fixed, so the turn
 * is compared against it directly.
 *
 * @param firstInvocation The first turn of the conversation.
 * @param conversationScenario The scenario the simulator was driving.
 * @param threshold The score a turn needs to pass.
 * @returns The result, which is not evaluated when the turn holds no text.
 */
export function evaluateFirstTurn(
  firstInvocation: Invocation,
  conversationScenario: ConversationScenario,
  threshold: number,
): PerInvocationResult {
  const userText = getTextFromContent(firstInvocation.userContent);
  if (userText === '') {
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
 * Folds the per-turn results into the score for the whole conversation: the
 * fraction of turns the judge accepted.
 *
 * @param perInvocationResults One result per turn, in order.
 * @param threshold The fraction a conversation needs to pass.
 * @returns The overall result, which carries no score when there are no turns.
 */
export function aggregateConversationResults(
  perInvocationResults: PerInvocationResult[],
  threshold: number,
): EvaluationResult {
  if (perInvocationResults.length === 0) {
    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults,
    };
  }

  let numValid = 0;
  for (const result of perInvocationResults) {
    if (result.evalStatus === EvalStatus.PASSED && result.score !== undefined) {
      numValid += result.score;
    }
  }

  const overallScore = numValid / perInvocationResults.length;
  return {
    overallScore,
    overallEvalStatus: getEvalStatus(overallScore, threshold),
    perInvocationResults,
  };
}

/**
 * Validates the criterion of a metric, reporting the type it expects.
 *
 * @throws {InputValidationError} When the metric carries no criterion, or one
 *   this metric does not accept.
 */
function parseCriterion(
  evalMetric: EvalMetric,
): ParsedLlmBackedUserSimulatorCriterion {
  const message =
    `\`${evalMetric.metricName}\` metric expects a criterion of type ` +
    `\`${CRITERION_TYPE_NAME}\`.`;

  if (evalMetric.criterion === undefined) {
    throw new InputValidationError(message);
  }
  try {
    return parseLlmBackedUserSimulatorCriterion(evalMetric.criterion);
  } catch (error) {
    throw new InputValidationError(message, {cause: error});
  }
}

/** The proxy turn that asks whether the conversation should have ended. */
function stopSignalInvocation(stopSignal: string): Invocation {
  return {
    invocationId: STOP_SIGNAL_INVOCATION_ID,
    userContent: {parts: [{text: stopSignal}]},
  };
}

/** How a {@link PerTurnUserSimulatorQualityV1} is configured. */
export interface PerTurnUserSimulatorQualityV1Options {
  evalMetric: EvalMetric;

  /**
   * The judge model to grade with. Resolved from `LLMRegistry` when absent.
   * Supply one to grade against a model the registry does not own.
   */
  judgeModel?: BaseLlm;
}

/**
 * Grades a user simulator rather than the agent it drove.
 *
 * The metric checks that the simulated conversation kept to its scenario: the
 * first turn repeats the starting prompt, every later turn follows the
 * conversation plan, and the conversation ends when it should. A judge model
 * grades every turn but the first, and repeated samples of one turn are folded
 * by majority vote. The overall score is the fraction of turns the judge
 * accepted.
 */
@experimental
export class PerTurnUserSimulatorQualityV1 implements Evaluator {
  private readonly judgeModelOptions: ResolvedJudgeModelOptions;
  private readonly threshold: number;
  private readonly stopSignal: string;
  private readonly judgeModel: BaseLlm;

  /**
   * @throws {InputValidationError} When the metric carries no criterion, or
   *   one that is not an `LlmBackedUserSimulatorCriterion`.
   */
  constructor(options: PerTurnUserSimulatorQualityV1Options) {
    const criterion = parseCriterion(options.evalMetric);
    this.threshold = criterion.threshold;
    this.judgeModelOptions = criterion.judgeModelOptions;
    this.stopSignal = criterion.stopSignal;
    this.judgeModel =
      options.judgeModel ??
      LLMRegistry.newLlm(this.judgeModelOptions.judgeModel);
  }

  /**
   * Grades every turn of a simulated conversation.
   *
   * @param actualInvocations The conversation the simulator produced.
   * @param _expectedInvocations Golden invocations, which this metric never
   *   reads: there is no golden answer for a simulated user turn.
   * @param conversationScenario The scenario the simulator was driving.
   * @returns One result per turn, and the fraction of turns that passed.
   * @throws {InputValidationError} When no scenario is supplied.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    _expectedInvocations?: Invocation[],
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
    for (let turn = 1; turn < actualInvocations.length; turn++) {
      results.push(
        await this.evaluateIntermediateTurn(
          actualInvocations[turn],
          actualInvocations.slice(0, turn),
          conversationScenario,
        ),
      );
    }

    // A conversation that should have ended and did not marks its last user
    // turn as the failure site, rather than adding a turn of its own.
    const stopSignalResult = await this.evaluateIntermediateTurn(
      stopSignalInvocation(this.stopSignal),
      actualInvocations,
      conversationScenario,
    );
    if (stopSignalResult.evalStatus === EvalStatus.FAILED) {
      results[results.length - 1] = stopSignalResult;
    }

    return aggregateConversationResults(results, this.threshold);
  }

  /**
   * Grades one turn against the turns that came before it.
   *
   * The samples are taken one after another, matching adk-python.
   */
  private async evaluateIntermediateTurn(
    invocationAtStep: Invocation,
    invocationHistory: Invocation[],
    conversationScenario: ConversationScenario,
  ): Promise<PerInvocationResult> {
    const autoRaterPrompt = formatPerTurnUserSimulatorPrompt({
      invocation: invocationAtStep,
      conversationScenario,
      previousInvocations: invocationHistory,
      stopSignal: this.stopSignal,
    });
    const llmRequest: LlmRequest = {
      // The model that answers, not the one the criterion names: `Gemini`
      // binds the outgoing call to `llmRequest.model` ahead of its own, so a
      // caller-supplied judge would otherwise be sent to the wrong model.
      model: this.judgeModel.model,
      contents: [{role: 'user', parts: [{text: autoRaterPrompt}]}],
      config: this.judgeModelOptions.judgeModelConfig ?? {},
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    const samples: PerInvocationResult[] = [];
    for (let sample = 0; sample < this.judgeModelOptions.numSamples; sample++) {
      const {score} = await this.sampleLlm(llmRequest);
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

  /** Asks the judge once. Returns no score when the judge does not answer. */
  private async sampleLlm(llmRequest: LlmRequest): Promise<AutoRaterScore> {
    // The call is non-streaming, so the first response is the whole answer.
    // Returning out of the loop closes the generator.
    for await (const llmResponse of this.judgeModel.generateContentAsync(
      llmRequest,
    )) {
      return convertLlmResponseToScore(llmResponse);
    }
    return {};
  }
}
