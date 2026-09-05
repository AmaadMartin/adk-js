/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content} from '@google/genai';

import type {LlmAgent} from '../agents/llm_agent.js';
import {NotFoundError} from '../errors/not_found_error.js';
import type {
  EvaluateRequest,
  InferenceRequest,
  InferenceResult,
} from '../evaluation/base_eval_service.js';
import {
  getAllToolCallsWithResponses,
  type IntermediateDataType,
  type Invocation,
} from '../evaluation/eval_case.js';
import {
  type EvalConfig,
  getEvalMetricsFromConfig,
} from '../evaluation/eval_config.js';
import {EvalStatus} from '../evaluation/eval_metrics.js';
import type {EvalCaseResult} from '../evaluation/eval_result.js';
import type {EvalSetsManager} from '../evaluation/eval_sets_manager.js';
import {LocalEvalService} from '../evaluation/local_eval_service.js';
import type {MetricEvaluatorRegistry} from '../evaluation/metric_evaluator_registry.js';
import {UserSimulatorProvider} from '../evaluation/simulation/user_simulator_provider.js';
import {logger} from '../utils/logger.js';
import type {UnstructuredSamplingResult} from './data_types.js';
import {
  type ExampleSet,
  type SampleAndScoreParams,
  Sampler,
} from './sampler.js';

/** How many decimals a metric score keeps in the captured eval data. */
const SCORE_DECIMALS = 2;

/** Configuration for {@link LocalEvalSampler}. */
export interface LocalEvalSamplerConfig {
  /** The configuration for the evaluation. */
  evalConfig: EvalConfig;

  /** The app name to use for evaluation. */
  appName: string;

  /** The name of the eval set to use for optimization. */
  trainEvalSet: string;

  /**
   * The ids of the eval cases to use for optimization. When absent, every eval
   * case in {@link trainEvalSet} is used.
   */
  trainEvalCaseIds?: string[];

  /**
   * The name of the eval set to use for validating the optimized agent. When
   * absent, {@link trainEvalSet} is used for validation too.
   */
  validationEvalSet?: string;

  /**
   * The ids of the eval cases to use for validating the optimized agent. When
   * absent, every eval case in the validation eval set is used. When
   * {@link validationEvalSet} is absent too, the train eval case ids are used.
   */
  validationEvalCaseIds?: string[];
}

/** Options for {@link LocalEvalSampler.create}. */
export interface LocalEvalSamplerOptions {
  config: LocalEvalSamplerConfig;

  evalSetsManager: EvalSetsManager;

  /** Defaults to `defaultMetricEvaluatorRegistry()`. */
  metricEvaluatorRegistry?: MetricEvaluatorRegistry;
}

/** One tool call paired with its response. */
export interface ToolCallData {
  name?: string;

  args?: Record<string, unknown>;

  /** Absent when no response matched the call id. */
  response?: Record<string, unknown>;
}

/** What {@link extractSingleInvocationInfo} reports about one invocation. */
export interface InvocationInfo {
  userPrompt: string;

  agentResponse: string;

  /** Absent when the invocation recorded no intermediate data. */
  toolCalls?: ToolCallData[];
}

/**
 * Extracts the tool calls and their responses from intermediate data.
 *
 * @param intermediateData The route an invocation took to its final response.
 * @returns One entry per tool call, in the order the calls were recorded.
 */
export function extractToolCallData(
  intermediateData?: IntermediateDataType,
): ToolCallData[] {
  return getAllToolCallsWithResponses(intermediateData).map(
    ([toolCall, toolResponse]) => {
      const entry: ToolCallData = {name: toolCall.name, args: toolCall.args};
      if (toolResponse) {
        entry.response = toolResponse.response;
      }
      return entry;
    },
  );
}

/**
 * Joins the text of every part that is not a thought.
 *
 * An optimizer reads the conversation the user and the agent had, so the
 * model's private reasoning is left out.
 */
function joinVisibleText(content?: Content): string {
  let text = '';
  for (const part of content?.parts ?? []) {
    if (part.text && !part.thought) {
      text += part.text;
    }
  }
  return text;
}

/**
 * Extracts the prompt, the response and the tool calls of one invocation.
 *
 * @param invocation The invocation to read.
 * @returns The parts of the invocation an optimizer needs.
 */
export function extractSingleInvocationInfo(
  invocation: Invocation,
): InvocationInfo {
  const info: InvocationInfo = {
    userPrompt: joinVisibleText(invocation.userContent),
    agentResponse: joinVisibleText(invocation.finalResponse),
  };
  if (invocation.intermediateData) {
    info.toolCalls = extractToolCallData(invocation.intermediateData);
  }
  return info;
}

/** Logs how many eval cases passed, failed, and did neither. */
function logEvalSummary(evalResults: EvalCaseResult[]): void {
  let numPass = 0;
  let numFail = 0;
  let numOther = 0;
  for (const evalResult of evalResults) {
    if (evalResult.finalEvalStatus === EvalStatus.PASSED) {
      numPass++;
    } else if (evalResult.finalEvalStatus === EvalStatus.FAILED) {
      numFail++;
    } else {
      numOther++;
    }
  }
  let logStr = `Evaluation summary: ${numPass} PASSED, ${numFail} FAILED`;
  if (numOther) {
    logStr += `, ${numOther} OTHER`;
  }
  logger.debug(logStr);
}

/** The eval sets and case ids a sampler works on, once resolved. */
interface ResolvedExampleSets {
  trainEvalSet: string;
  trainEvalCaseIds: string[];
  validationEvalSet: string;
  validationEvalCaseIds: string[];
}

/**
 * Resolves the eval sets and case ids the config selects.
 *
 * An id list the config states is used as given. Otherwise the ids come from
 * the eval set, except that a config naming no validation set validates on the
 * train cases.
 *
 * @throws {NotFoundError} If an eval set the config names does not exist.
 */
async function resolveExampleSets(
  config: LocalEvalSamplerConfig,
  evalSetsManager: EvalSetsManager,
): Promise<ResolvedExampleSets> {
  const {appName, trainEvalSet, validationEvalSet} = config;
  const trainEvalCaseIds =
    config.trainEvalCaseIds ??
    (await getEvalCaseIds(evalSetsManager, appName, trainEvalSet));

  let validationEvalCaseIds = config.validationEvalCaseIds;
  if (!validationEvalCaseIds) {
    validationEvalCaseIds = validationEvalSet
      ? await getEvalCaseIds(evalSetsManager, appName, validationEvalSet)
      : trainEvalCaseIds;
  }

  return {
    trainEvalSet,
    trainEvalCaseIds,
    validationEvalSet: validationEvalSet ?? trainEvalSet,
    validationEvalCaseIds,
  };
}

/**
 * Scores a candidate agent by running the ADK's `LocalEvalService` over the
 * eval cases of a named eval set.
 *
 * Construct it with {@link LocalEvalSampler.create}: resolving the eval case
 * ids of a set is asynchronous in adk-js, and a constructor cannot await.
 */
export class LocalEvalSampler extends Sampler<UnstructuredSamplingResult> {
  private constructor(
    private readonly options: LocalEvalSamplerOptions,
    private readonly exampleSets: ResolvedExampleSets,
  ) {
    super();
  }

  /**
   * Resolves the train and validation eval case ids, then builds the sampler.
   *
   * @param options The configuration, the eval sets manager, and optionally
   *     the registry that resolves a metric name to an evaluator.
   * @throws {NotFoundError} If an eval set the config names does not exist.
   */
  static async create(
    options: LocalEvalSamplerOptions,
  ): Promise<LocalEvalSampler> {
    return new LocalEvalSampler(
      options,
      await resolveExampleSets(options.config, options.evalSetsManager),
    );
  }

  /** Returns the ids of the eval cases used to train the agent. */
  getTrainExampleIds(): string[] {
    return this.exampleSets.trainEvalCaseIds;
  }

  /** Returns the ids of the eval cases used to validate the optimized agent. */
  getValidationExampleIds(): string[] {
    return this.exampleSets.validationEvalCaseIds;
  }

  /**
   * Evaluates the candidate agent on a batch of eval cases.
   *
   * @param params The candidate, the example set, the batch of eval case ids,
   *     and whether to capture the full evaluation data.
   * @returns One score per eval case, and the captured data when it was asked
   *     for.
   */
  async sampleAndScore(
    params: SampleAndScoreParams,
  ): Promise<UnstructuredSamplingResult> {
    const {
      candidate,
      exampleSet = Sampler.VALIDATION_SET,
      batch,
      captureFullEvalData = false,
    } = params;
    const evalSetId = this.getSelectedExampleSetId(exampleSet);
    const evalCaseIds = batch ?? this.getAllExampleIds(exampleSet);

    const evalResults = await this.evaluateAgent(
      candidate,
      evalSetId,
      evalCaseIds,
    );
    logEvalSummary(evalResults);

    const scores: Record<string, number> = {};
    for (const evalResult of evalResults) {
      scores[evalResult.evalId] =
        evalResult.finalEvalStatus === EvalStatus.PASSED ? 1.0 : 0.0;
    }

    if (!captureFullEvalData) {
      return {scores};
    }
    return {scores, data: await this.extractEvalData(evalSetId, evalResults)};
  }

  private getSelectedExampleSetId(exampleSet: ExampleSet): string {
    return exampleSet === Sampler.TRAIN_SET
      ? this.exampleSets.trainEvalSet
      : this.exampleSets.validationEvalSet;
  }

  private getAllExampleIds(exampleSet: ExampleSet): string[] {
    return exampleSet === Sampler.TRAIN_SET
      ? this.exampleSets.trainEvalCaseIds
      : this.exampleSets.validationEvalCaseIds;
  }

  /**
   * Runs inference for the candidate and scores what it produced.
   *
   * A `LocalEvalService` is built per call so it wraps the candidate given to
   * this call, not the one given to an earlier call.
   */
  private async evaluateAgent(
    agent: LlmAgent,
    evalSetId: string,
    evalCaseIds: string[],
  ): Promise<EvalCaseResult[]> {
    const inferenceRequest: InferenceRequest = {
      appName: this.options.config.appName,
      evalSetId,
      evalCaseIds,
      inferenceConfig: {useLive: false},
    };
    const evalService = new LocalEvalService({
      rootAgent: agent,
      evalSetsManager: this.options.evalSetsManager,
      metricEvaluatorRegistry: this.options.metricEvaluatorRegistry,
      userSimulatorProvider: new UserSimulatorProvider(
        this.options.config.evalConfig.userSimulatorConfig,
      ),
    });

    const inferenceResults: InferenceResult[] = [];
    for await (const inferenceResult of evalService.performInference(
      inferenceRequest,
    )) {
      inferenceResults.push(inferenceResult);
    }

    const evaluateRequest: EvaluateRequest = {
      inferenceResults,
      evaluateConfig: {
        evalMetrics: getEvalMetricsFromConfig(this.options.config.evalConfig),
      },
    };
    const evalResults: EvalCaseResult[] = [];
    for await (const evalResult of evalService.evaluate(evaluateRequest)) {
      evalResults.push(evalResult);
    }
    return evalResults;
  }

  /** Collects the per-invocation detail an optimizer needs. */
  private async extractEvalData(
    evalSetId: string,
    evalResults: EvalCaseResult[],
  ): Promise<Record<string, Record<string, unknown>>> {
    const evalData: Record<string, Record<string, unknown>> = {};
    for (const evalResult of evalResults) {
      const evalResultData: Record<string, unknown> = {};
      const evalCase = await this.options.evalSetsManager.getEvalCase(
        this.options.config.appName,
        evalSetId,
        evalResult.evalId,
      );
      if (evalCase?.conversationScenario) {
        evalResultData['conversationScenario'] = evalCase.conversationScenario;
      }

      evalResultData['invocations'] =
        evalResult.evalMetricResultPerInvocation.map((perInvocationResult) => {
          const invocationData: Record<string, unknown> = {
            actualInvocation: extractSingleInvocationInfo(
              perInvocationResult.actualInvocation,
            ),
            evalMetricResults: perInvocationResult.evalMetricResults.map(
              (metricResult) => ({
                metricName: metricResult.metricName,
                score: roundScore(metricResult.score),
                evalStatus: EvalStatus[metricResult.evalStatus],
              }),
            ),
          };
          if (perInvocationResult.expectedInvocation) {
            invocationData['expectedInvocation'] = extractSingleInvocationInfo(
              perInvocationResult.expectedInvocation,
            );
          }
          return invocationData;
        });
      evalData[evalResult.evalId] = evalResultData;
    }
    return evalData;
  }
}

/**
 * Rounds a metric score to {@link SCORE_DECIMALS} decimals.
 *
 * adk-python rounds half to even; this rounds half away from zero. The two
 * differ only on an exact tie at the third decimal.
 */
function roundScore(score?: number): number | undefined {
  if (score === undefined) {
    return undefined;
  }
  const factor = 10 ** SCORE_DECIMALS;
  return Math.round(score * factor) / factor;
}

/**
 * Returns the ids of every eval case in an eval set.
 *
 * @throws {NotFoundError} If the app has no eval set with that id.
 */
async function getEvalCaseIds(
  evalSetsManager: EvalSetsManager,
  appName: string,
  evalSetId: string,
): Promise<string[]> {
  const evalSet = await evalSetsManager.getEvalSet(appName, evalSetId);
  if (!evalSet) {
    throw new NotFoundError(
      `Eval set \`${evalSetId}\` does not exist for app \`${appName}\`.`,
    );
  }
  return evalSet.evalCases.map((evalCase) => evalCase.evalId);
}
