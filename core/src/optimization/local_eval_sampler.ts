/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Part} from '@google/genai';

import type {LlmAgent} from '../agents/llm_agent.js';
import {NotFoundError} from '../errors/not_found_error.js';
import type {InferenceResult} from '../evaluation/base_eval_service.js';
import type {
  ConversationScenario,
  IntermediateDataType,
  Invocation,
} from '../evaluation/eval_case.js';
import {getAllToolCallsWithResponses} from '../evaluation/eval_case.js';
import type {EvalConfig} from '../evaluation/eval_config.js';
import {getEvalMetricsFromConfig} from '../evaluation/eval_config.js';
import type {
  EvalMetricResult,
  EvalMetricResultPerInvocation,
} from '../evaluation/eval_metrics.js';
import {EvalStatus} from '../evaluation/eval_metrics.js';
import type {EvalCaseResult} from '../evaluation/eval_result.js';
import type {EvalSetsManager} from '../evaluation/eval_sets_manager.js';
import {LocalEvalService} from '../evaluation/local_eval_service.js';
import {
  defaultMetricEvaluatorRegistry,
  MetricEvaluatorRegistry,
  registerCustomMetricsFromConfig,
} from '../evaluation/metric_evaluator_registry.js';
import {UserSimulatorProvider} from '../evaluation/simulation/user_simulator_provider.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import type {UnstructuredSamplingResult} from './data_types.js';
import type {ExampleSet, SampleAndScoreParams} from './sampler.js';
import {Sampler} from './sampler.js';

/** Decimal places a captured metric score keeps. */
const SCORE_DECIMALS = 2;

/** Which eval sets and eval cases {@link LocalEvalSampler} scores. */
interface ResolvedExampleSets {
  trainEvalSet: string;
  trainEvalCaseIds: string[];
  validationEvalSet: string;
  validationEvalCaseIds: string[];
}

/** Configuration for {@link LocalEvalSampler}. */
export interface LocalEvalSamplerConfig {
  /** The configuration for the evaluation. */
  evalConfig: EvalConfig;

  /** The app name to use for evaluation. */
  appName: string;

  /** The name of the eval set to use for optimization. */
  trainEvalSet: string;

  /**
   * The ids of the eval cases to use for optimization. When omitted, every
   * eval case in {@link trainEvalSet} is used.
   */
  trainEvalCaseIds?: string[];

  /**
   * The name of the eval set to use for validating the optimized agent. When
   * omitted, {@link trainEvalSet} is used for validation too.
   */
  validationEvalSet?: string;

  /**
   * The ids of the eval cases to use for validating the optimized agent. When
   * omitted, every eval case in {@link validationEvalSet} is used. When
   * {@link validationEvalSet} is also omitted, the train eval case ids are
   * used.
   */
  validationEvalCaseIds?: string[];
}

/** Options for {@link LocalEvalSampler.create}. */
export interface LocalEvalSamplerOptions {
  config: LocalEvalSamplerConfig;

  evalSetsManager: EvalSetsManager;

  /**
   * The registry the eval run resolves metric names against. Defaults to
   * {@link defaultMetricEvaluatorRegistry}. The sampler registers the config's
   * custom metrics into a {@link MetricEvaluatorRegistry.fork} of it, so those
   * registrations never reach the registry the caller passed.
   */
  metricEvaluatorRegistry?: MetricEvaluatorRegistry;
}

/** One tool call paired with its response. */
export interface ToolCallData {
  name?: string;

  args?: Record<string, unknown>;

  /** Absent when no response carried the call id. */
  response?: Record<string, unknown>;
}

/** What {@link extractSingleInvocationInfo} reports about one invocation. */
export interface InvocationInfo {
  userPrompt: string;

  agentResponse: string;

  /** Absent when the invocation recorded no intermediate data. */
  toolCalls?: ToolCallData[];
}

/** One metric's verdict, as an optimizer reads it back. */
export type CapturedMetricResult = {
  metricName: string;

  /** Rounded to two decimals. Undefined when nothing scored the metric. */
  score?: number;

  /** The {@link EvalStatus} name, e.g. `'PASSED'`. */
  evalStatus: string;
};

/** One invocation's prompts, responses and metric verdicts. */
export type CapturedInvocation = {
  actualInvocation: InvocationInfo;

  evalMetricResults: CapturedMetricResult[];

  /** Absent when the eval case recorded no reference invocation. */
  expectedInvocation?: InvocationInfo;
};

/** Everything captured for one eval case. */
export type CapturedEvalData = {
  /** Absent when the eval case has none, or the manager does not have it. */
  conversationScenario?: ConversationScenario;

  invocations: CapturedInvocation[];
};

/**
 * What {@link LocalEvalSampler.sampleAndScore} returns.
 *
 * It narrows `data` to {@link CapturedEvalData}, so a caller reads the
 * captured invocations without re-narrowing what the sampler already knew.
 */
export interface LocalEvalSamplingResult extends UnstructuredSamplingResult {
  data?: Record<string, CapturedEvalData>;
}

/**
 * Extracts the tool calls and their responses from an invocation's
 * intermediate data.
 *
 * @param intermediateData The recorded trajectory or invocation events.
 * @return One entry per call, in recorded order. `response` is omitted when no
 *   response carried the call id.
 */
export function extractToolCallData(
  intermediateData?: IntermediateDataType,
): ToolCallData[] {
  return getAllToolCallsWithResponses(intermediateData).map(
    ([toolCall, toolResponse]): ToolCallData => ({
      name: toolCall.name,
      args: toolCall.args,
      response: toolResponse?.response,
    }),
  );
}

/** Concatenates the text of every part the model did not mark as a thought. */
function joinVisibleText(parts?: Part[]): string {
  return (parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('');
}

/**
 * Extracts what an optimizer needs to read from a single invocation.
 *
 * Parts the model marked as thoughts are left out of both texts, so the
 * optimizer reasons about what the user and the agent actually said.
 */
export function extractSingleInvocationInfo(
  invocation: Invocation,
): InvocationInfo {
  const info: InvocationInfo = {
    userPrompt: joinVisibleText(invocation.userContent?.parts),
    agentResponse: joinVisibleText(invocation.finalResponse?.parts),
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
  logger.info(logStr);
}

/**
 * Returns the ids of every eval case in an eval set.
 *
 * @throws {NotFoundError} When the app has no eval set with that id.
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

/**
 * Resolves the train and validation eval sets a config names.
 *
 * @throws {NotFoundError} When a named eval set does not exist and the config
 *   does not list its eval case ids.
 */
async function resolveExampleSets(
  config: LocalEvalSamplerConfig,
  evalSetsManager: EvalSetsManager,
): Promise<ResolvedExampleSets> {
  const {appName, trainEvalSet} = config;
  const trainEvalCaseIds =
    config.trainEvalCaseIds ??
    (await getEvalCaseIds(evalSetsManager, appName, trainEvalSet));

  let validationEvalCaseIds: string[];
  if (config.validationEvalCaseIds !== undefined) {
    validationEvalCaseIds = config.validationEvalCaseIds;
  } else if (config.validationEvalSet !== undefined) {
    validationEvalCaseIds = await getEvalCaseIds(
      evalSetsManager,
      appName,
      config.validationEvalSet,
    );
  } else {
    // Validation reuses the train ids rather than the whole train set, so a
    // configured subset of train cases carries over instead of widening.
    validationEvalCaseIds = trainEvalCaseIds;
  }

  return {
    trainEvalSet,
    trainEvalCaseIds,
    validationEvalSet: config.validationEvalSet ?? trainEvalSet,
    validationEvalCaseIds,
  };
}

/** Rounds a captured score, leaving an unscored metric unscored. */
function roundScore(score?: number): number | undefined {
  if (score === undefined) {
    return undefined;
  }
  const factor = 10 ** SCORE_DECIMALS;
  return Math.round(score * factor) / factor;
}

/** Captures one metric verdict in the shape an optimizer reads. */
function captureMetricResult(
  evalMetricResult: EvalMetricResult,
): CapturedMetricResult {
  return {
    metricName: evalMetricResult.metricName,
    score: roundScore(evalMetricResult.score),
    evalStatus: EvalStatus[evalMetricResult.evalStatus],
  };
}

/** Captures one invocation's prompts, responses and metric verdicts. */
function captureInvocation(
  perInvocationResult: EvalMetricResultPerInvocation,
): CapturedInvocation {
  const captured: CapturedInvocation = {
    actualInvocation: extractSingleInvocationInfo(
      perInvocationResult.actualInvocation,
    ),
    evalMetricResults:
      perInvocationResult.evalMetricResults.map(captureMetricResult),
  };
  if (perInvocationResult.expectedInvocation) {
    captured.expectedInvocation = extractSingleInvocationInfo(
      perInvocationResult.expectedInvocation,
    );
  }
  return captured;
}

/**
 * Scores a candidate agent by running ADK's `LocalEvalService` over an eval
 * set.
 *
 * An optimizer proposes a candidate and asks for a score per eval case. This
 * sampler runs the candidate over the eval cases of the selected eval set and
 * maps each case's final status to a score: `PASSED` is `1.0` and everything
 * else, including `NOT_EVALUATED`, is `0.0`. When the optimizer asks for it,
 * the sampler also captures what the agent said and which tools it called, so
 * the optimizer can reason about why a case failed.
 *
 * Build one with {@link LocalEvalSampler.create}, not with `new`. Resolving
 * the eval case ids reads the {@link EvalSetsManager}, whose methods are
 * asynchronous in adk-js, and a constructor cannot await.
 */
@experimental
export class LocalEvalSampler extends Sampler<LocalEvalSamplingResult> {
  private constructor(
    private readonly config: LocalEvalSamplerConfig,
    private readonly evalSetsManager: EvalSetsManager,
    private readonly metricEvaluatorRegistry: MetricEvaluatorRegistry,
    private readonly exampleSets: ResolvedExampleSets,
  ) {
    super();
  }

  /**
   * Builds a sampler, resolving the eval case ids of both example sets.
   *
   * @throws {NotFoundError} When a named eval set does not exist and the
   *   config does not list its eval case ids.
   */
  static async create(
    options: LocalEvalSamplerOptions,
  ): Promise<LocalEvalSampler> {
    const exampleSets = await resolveExampleSets(
      options.config,
      options.evalSetsManager,
    );
    const registry = (
      options.metricEvaluatorRegistry ?? defaultMetricEvaluatorRegistry()
    ).fork();
    return new LocalEvalSampler(
      options.config,
      options.evalSetsManager,
      registerCustomMetricsFromConfig(options.config.evalConfig, registry),
      exampleSets,
    );
  }

  override getTrainExampleIds(): string[] {
    return this.exampleSets.trainEvalCaseIds;
  }

  override getValidationExampleIds(): string[] {
    return this.exampleSets.validationEvalCaseIds;
  }

  /**
   * Evaluates the candidate agent on a batch of eval cases.
   *
   * @return One score per {@link EvalCaseResult} the eval service yielded,
   *   which is not necessarily one per requested id: a case the service drops
   *   is absent from `scores`.
   */
  override async sampleAndScore({
    candidate,
    exampleSet = Sampler.VALIDATION_SET,
    batch,
    captureFullEvalData = false,
  }: SampleAndScoreParams): Promise<LocalEvalSamplingResult> {
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

  /** Runs inference for the eval cases, then scores the inferences. */
  private async evaluateAgent(
    candidate: LlmAgent,
    evalSetId: string,
    evalCaseIds: string[],
  ): Promise<EvalCaseResult[]> {
    const evalService = new LocalEvalService({
      rootAgent: candidate,
      evalSetsManager: this.evalSetsManager,
      metricEvaluatorRegistry: this.metricEvaluatorRegistry,
      userSimulatorProvider: new UserSimulatorProvider(
        this.config.evalConfig.userSimulatorConfig,
      ),
    });

    const inferenceResults: InferenceResult[] = [];
    for await (const inferenceResult of evalService.performInference({
      appName: this.config.appName,
      evalSetId,
      evalCaseIds,
      inferenceConfig: {useLive: false},
    })) {
      inferenceResults.push(inferenceResult);
    }

    const evalResults: EvalCaseResult[] = [];
    for await (const evalResult of evalService.evaluate({
      inferenceResults,
      evaluateConfig: {
        evalMetrics: getEvalMetricsFromConfig(this.config.evalConfig),
      },
    })) {
      evalResults.push(evalResult);
    }
    return evalResults;
  }

  /** Captures the per-invocation data an optimizer reads back. */
  private async extractEvalData(
    evalSetId: string,
    evalResults: EvalCaseResult[],
  ): Promise<Record<string, CapturedEvalData>> {
    const evalData: Record<string, CapturedEvalData> = {};
    for (const evalResult of evalResults) {
      const evalCase = await this.evalSetsManager.getEvalCase(
        this.config.appName,
        evalSetId,
        evalResult.evalId,
      );
      const invocations =
        evalResult.evalMetricResultPerInvocation.map(captureInvocation);
      // The scenario is passed on by reference, unserialized.
      evalData[evalResult.evalId] = evalCase?.conversationScenario
        ? {conversationScenario: evalCase.conversationScenario, invocations}
        : {invocations};
    }
    return evalData;
  }
}
