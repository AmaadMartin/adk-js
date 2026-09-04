/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../../errors/input_validation_error.js';
import type {BaseLlm} from '../../models/base_llm.js';
import type {LlmRequest} from '../../models/llm_request.js';
import type {LlmResponse} from '../../models/llm_response.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import type {ConversationScenario} from '../conversation_scenarios.js';
import type {Invocation} from '../eval_case.js';
import type {
  EvalMetric,
  LlmBackedUserSimulatorCriterion,
  ResolvedJudgeModelOptions,
} from '../eval_metrics.js';
import {
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  parseLlmBackedUserSimulatorCriterion,
  resolveJudgeModelOptions,
} from '../eval_metrics.js';
import type {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
} from '../evaluator.js';
import {
  EvalStatus,
  emptyEvaluationResult,
  getEvalStatus,
  getTextFromContent,
} from '../evaluator.js';
import type {AutoRaterScore} from '../llm_as_judge.js';
import {parseMetricCriterion} from '../llm_as_judge.js';
import {Label, PARTIALLY_VALID_LABELS} from '../llm_as_judge_utils.js';
import {addDefaultRetryOptionsIfNotPresent} from '../retry_options_utils.js';
import {getPerTurnUserSimulatorQualityPrompt} from './per_turn_user_simulator_quality_prompts.js';

/** Matches the `is_valid` field of a judge critique. */
const IS_VALID_PATTERN =
  /"is_valid":\s*\[*[\n\s]*"*([^"\]]*)"*[\n\s]*\]*\s*[,\n}]/;

/** The spellings of `is_valid` that reject a turn. */
const INVALID_IS_VALID_LABELS: ReadonlySet<string> = new Set([
  Label.INVALID,
  Label.ALMOST,
  Label.FALSE,
  ...PARTIALLY_VALID_LABELS,
]);

/** The spellings of `is_valid` that accept a turn. */
const VALID_IS_VALID_LABELS: ReadonlySet<string> = new Set([
  Label.VALID,
  Label.TRUE,
]);

/** The invocation id of the synthetic turn that carries the stop signal. */
const STOP_SIGNAL_INVOCATION_ID = 'stop_signal_proxy_invocation';

/** The role reported for an agent reply that names none. */
const DEFAULT_AGENT_ROLE = 'model';

/** How a {@link PerTurnUserSimulatorQualityV1} is configured. */
export interface PerTurnUserSimulatorQualityV1Options {
  evalMetric: EvalMetric;

  /**
   * The judge model to grade with. Resolved from `LLMRegistry` when absent.
   * Supply one to grade against a model the registry does not own.
   */
  judgeModel?: BaseLlm;
}

/** How a per-turn prompt names the turn it grades and the turns before it. */
export interface PerTurnUserSimulatorPromptOptions {
  /** The simulated user turn the judge grades. */
  invocation: Invocation;

  /** The scenario the simulated user was given. */
  conversationScenario?: ConversationScenario;

  /** The turns that came before, in order. */
  previousInvocations?: Invocation[];

  /** The signal that marks the conversation complete. */
  stopSignal: string;
}

/**
 * Reads the `is_valid` verdict out of a judge critique.
 *
 * @returns {@link Label.NOT_FOUND} when the critique carries no `is_valid`
 *   field, or one whose value is not a verdict this metric recognizes.
 */
export function parseIsValidLabel(response: string): Label {
  const match = IS_VALID_PATTERN.exec(response);
  if (match === null) {
    return Label.NOT_FOUND;
  }

  const label = match[1]
    .replace(/^\}+|\}+$/g, '')
    .replace(/,/g, '')
    .trim()
    .toLowerCase();

  if (INVALID_IS_VALID_LABELS.has(label)) {
    return Label.INVALID;
  }
  if (VALID_IS_VALID_LABELS.has(label)) {
    return Label.VALID;
  }
  return Label.NOT_FOUND;
}

/**
 * Renders a conversation as the transcript a judge model reads.
 *
 * A turn contributes a `user:` line when it carries user parts, and a line
 * named after the replying role when it carries a final response. adk-python
 * writes the literal `None` for a reply that names no role; this writes
 * `{@link DEFAULT_AGENT_ROLE}`.
 */
export function formatConversationHistory(invocations: Invocation[]): string {
  const lines: string[] = [];

  for (const invocation of invocations) {
    if (invocation.userContent.parts?.length) {
      lines.push(`user: ${getTextFromContent(invocation.userContent)}`);
    }

    const finalResponse = invocation.finalResponse;
    if (finalResponse !== undefined) {
      const role = finalResponse.role ?? DEFAULT_AGENT_ROLE;
      lines.push(`${role}: ${getTextFromContent(finalResponse)}`);
    }
  }

  return lines.join('\n\n');
}

/**
 * Formats the prompt that grades one simulated user turn.
 *
 * @throws {InputValidationError} When the previous invocations or the
 *   conversation scenario are absent.
 */
export function formatPerTurnUserSimulatorPrompt(
  options: PerTurnUserSimulatorPromptOptions,
): string {
  const {invocation, conversationScenario, previousInvocations} = options;

  if (previousInvocations === undefined) {
    throw new InputValidationError(
      'Previous invocations should have a set value when formatting the LLM ' +
        'prompt.',
    );
  }
  if (conversationScenario === undefined) {
    throw new InputValidationError(
      'Conversation scenario should have a set value when formatting the LLM ' +
        'prompt.',
    );
  }

  return getPerTurnUserSimulatorQualityPrompt({
    conversationPlan: conversationScenario.conversationPlan,
    conversationHistory: formatConversationHistory(previousInvocations),
    generatedUserResponse: getTextFromContent(invocation.userContent),
    stopSignal: options.stopSignal,
    userPersona: conversationScenario.userPersona,
  });
}

/**
 * Reads the score out of one judge critique.
 *
 * @returns A score of 1 for an accepted turn and 0 for a rejected one. No
 *   score at all when the critique carries no verdict.
 */
export function convertLlmResponseToScore(
  llmResponse: LlmResponse,
): AutoRaterScore {
  const responseText = getTextFromContent(llmResponse.content);
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
 * Folds the repeated samples of one turn into a single result by majority
 * vote.
 *
 * A tie goes to the samples that rejected the turn: a judge that cannot decide
 * does not pass a turn. When no sample scored at all, the first one stands.
 *
 * @throws {InputValidationError} When there are no samples to fold.
 */
export function aggregateSamples(
  samples: PerInvocationResult[],
): PerInvocationResult {
  if (samples.length === 0) {
    throw new InputValidationError('No samples to aggregate into a result.');
  }

  const positive = samples.filter((sample) => sample.score === 1.0);
  const negative = samples.filter((sample) => sample.score === 0.0);

  if (positive.length === 0 && negative.length === 0) {
    return samples[0];
  }
  return positive.length > negative.length ? positive[0] : negative[0];
}

/**
 * Folds the per-turn results into the overall result, scoring the conversation
 * as the fraction of its turns that passed.
 */
export function aggregateConversationResults(
  perInvocationResults: PerInvocationResult[],
  threshold: number,
): EvaluationResult {
  if (perInvocationResults.length === 0) {
    return emptyEvaluationResult();
  }

  const numValid = perInvocationResults.reduce(
    (total, result) =>
      result.evalStatus === EvalStatus.PASSED
        ? total + (result.score ?? 0)
        : total,
    0,
  );

  const overallScore = numValid / perInvocationResults.length;
  return {
    overallScore,
    overallEvalStatus: getEvalStatus(overallScore, threshold),
    perInvocationResults,
  };
}

/**
 * Grades the first turn, which must repeat the scenario's starting prompt.
 *
 * The starting prompt is fixed data, so no judge model is consulted. A turn
 * that carries no text is not evaluated.
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

/** Builds the synthetic turn that asks whether the conversation should end. */
function buildStopSignalInvocation(stopSignal: string): Invocation {
  return {
    invocationId: STOP_SIGNAL_INVOCATION_ID,
    userContent: {parts: [{text: stopSignal}]},
  };
}

/**
 * Grades a simulated user turn by turn, against the scenario it was produced
 * from.
 *
 * The first turn must repeat the scenario's starting prompt. Every later turn
 * is graded by a judge model against the conversation plan, the transcript so
 * far and the user persona. One further judge call asks whether the
 * conversation should already have ended; when it says so, the last turn is
 * reported as the failure. The overall score is the fraction of turns that
 * passed.
 *
 * Sampling is sequential, matching adk-python, so
 * `judgeModelOptions.parallelismLimit` does not apply to this metric.
 */
@experimental
export class PerTurnUserSimulatorQualityV1 implements Evaluator {
  private readonly criterion: LlmBackedUserSimulatorCriterion;
  private readonly judgeModelOptions: ResolvedJudgeModelOptions;
  private readonly threshold: number;
  private readonly stopSignal: string;
  private readonly judgeModel: BaseLlm;

  /**
   * @throws {InputValidationError} When the metric carries no criterion, or
   *   one that is not an `LlmBackedUserSimulatorCriterion`.
   */
  constructor(options: PerTurnUserSimulatorQualityV1Options) {
    this.criterion = parseMetricCriterion(
      options.evalMetric,
      parseLlmBackedUserSimulatorCriterion,
    );
    this.judgeModelOptions = resolveJudgeModelOptions(
      this.criterion.judgeModelOptions,
    );
    this.threshold = this.criterion.threshold;
    this.stopSignal =
      this.criterion.stopSignal ?? DEFAULT_USER_SIMULATOR_STOP_SIGNAL;
    this.judgeModel =
      options.judgeModel ??
      LLMRegistry.newLlm(this.judgeModelOptions.judgeModel);
  }

  /**
   * Grades every turn of a simulated conversation.
   *
   * @param actualInvocations The simulated conversation, in order.
   * @param _expectedInvocations Never read. A simulated user turn has no
   *   golden answer to be scored against.
   * @param conversationScenario The scenario the simulated user was given.
   * @throws {InputValidationError} When the scenario is absent.
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
        await this.evaluateTurn(
          actualInvocations[turn],
          actualInvocations.slice(0, turn),
          conversationScenario,
        ),
      );
    }

    const stopSignalResult = await this.evaluateTurn(
      buildStopSignalInvocation(this.stopSignal),
      actualInvocations,
      conversationScenario,
    );
    // A conversation that should have ended already is reported on the last
    // real turn rather than as a turn of its own.
    if (stopSignalResult.evalStatus === EvalStatus.FAILED) {
      results[results.length - 1] = stopSignalResult;
    }

    return aggregateConversationResults(results, this.threshold);
  }

  /** Grades one turn against the turns before it, by majority vote. */
  private async evaluateTurn(
    invocation: Invocation,
    previousInvocations: Invocation[],
    conversationScenario: ConversationScenario,
  ): Promise<PerInvocationResult> {
    const llmRequest: LlmRequest = {
      // The model that answers, not the one the criterion names: `Gemini`
      // binds the outgoing call to `llmRequest.model` ahead of its own, so a
      // caller-supplied judge would otherwise be sent to the wrong model.
      model: this.judgeModel.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: formatPerTurnUserSimulatorPrompt({
                invocation,
                conversationScenario,
                previousInvocations,
                stopSignal: this.stopSignal,
              }),
            },
          ],
        },
      ],
      config: this.judgeModelOptions.judgeModelConfig ?? {},
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    const samples: PerInvocationResult[] = [];
    for (let sample = 0; sample < this.judgeModelOptions.numSamples; sample++) {
      const {score} = await this.sampleJudge(llmRequest);
      samples.push({
        actualInvocation: invocation,
        score,
        evalStatus: getEvalStatus(score, this.threshold),
      });
    }

    if (samples.length === 0) {
      return {
        actualInvocation: invocation,
        evalStatus: EvalStatus.NOT_EVALUATED,
      };
    }
    return aggregateSamples(samples);
  }

  /** Asks the judge once. Returns no score when it does not answer. */
  private async sampleJudge(llmRequest: LlmRequest): Promise<AutoRaterScore> {
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
