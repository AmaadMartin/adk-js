/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App} from '../apps/app.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {InMemoryArtifactService} from '../artifacts/in_memory_artifact_service.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {Session} from '../sessions/session.js';
import {EVAL_CLIENT_LABEL, runWithClientLabel} from '../utils/client_labels.js';
import {mapConcurrent} from '../utils/concurrency_utils.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {RunnableRoot} from '../workflow/run_node_as_invocation.js';
import {
  BaseEvalService,
  DEFAULT_EVAL_PARALLELISM,
  EvaluateConfig,
  EvaluateRequest,
  InferenceRequest,
  InferenceResult,
  InferenceStatus,
} from './base_eval_service.js';
import {DEFAULT_LIVE_TIMEOUT_SECONDS} from './constants.js';
import {EvalCase, Invocation} from './eval_case.js';
import {
  EvalMetric,
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalStatus,
} from './eval_metrics.js';
import {EvalCaseResult} from './eval_result.js';
import {
  copyEvalCaseRubricsToActualInvocations,
  copyInvocationRubricsToActualInvocations,
} from './eval_rubrics.js';
import {EvalSetResultsManager} from './eval_set_results_manager.js';
import {EvalSetsManager} from './eval_sets_manager.js';
import {
  generateInferencesFromRootAgent,
  generateInferencesFromRootAgentLive,
} from './evaluation_generator.js';
import {emptyEvaluationResult, EvaluationResult} from './evaluator.js';
import {
  defaultMetricEvaluatorRegistry,
  MetricEvaluatorRegistry,
} from './metric_evaluator_registry.js';
import {UserSimulatorProvider} from './simulation/user_simulator_provider.js';

/** Marks a session as one an eval run created, rather than a user session. */
export const EVAL_SESSION_ID_PREFIX = '___eval___session___';

/** The user id an eval case runs under when its session input names none. */
const DEFAULT_EVAL_USER_ID = 'test_user_id';

/** Returns the id of a session an eval run owns. */
export function createEvalSessionId(): string {
  return `${EVAL_SESSION_ID_PREFIX}${randomUUID()}`;
}

/**
 * Folds the per-metric verdicts into the verdict for the whole eval case.
 *
 * One failing metric fails the case. A metric that was not evaluated does not
 * count either way, so a case whose metrics all went unevaluated is itself
 * `NOT_EVALUATED`.
 *
 * @throws {InputValidationError} If a metric carries a status this fold does
 *   not know, which is how a newly added `EvalStatus` member surfaces.
 */
export function generateFinalEvalStatus(
  overallEvalMetricResults: EvalMetricResult[],
): EvalStatus {
  let finalEvalStatus = EvalStatus.NOT_EVALUATED;
  for (const {evalStatus} of overallEvalMetricResults) {
    switch (evalStatus) {
      case EvalStatus.PASSED:
        finalEvalStatus = EvalStatus.PASSED;
        break;
      case EvalStatus.NOT_EVALUATED:
        break;
      case EvalStatus.FAILED:
        return EvalStatus.FAILED;
      default:
        throw new InputValidationError(`Unknown eval status: ${evalStatus}.`);
    }
  }
  return finalEvalStatus;
}

/** Options for {@link LocalEvalService}. */
export interface LocalEvalServiceOptions {
  /**
   * The agent under evaluation. A `Workflow` root is accepted because the
   * evaluation generator runs one.
   */
  rootAgent: RunnableRoot;

  evalSetsManager: EvalSetsManager;

  /** Defaults to {@link defaultMetricEvaluatorRegistry}. */
  metricEvaluatorRegistry?: MetricEvaluatorRegistry;

  /** Defaults to a fresh `InMemorySessionService`. */
  sessionService?: BaseSessionService;

  /** Defaults to a fresh `InMemoryArtifactService`. */
  artifactService?: BaseArtifactService;

  /** Forwarded to the evaluation generator as given, which may be absent. */
  memoryService?: BaseMemoryService;

  /** When absent, results are yielded but never persisted. */
  evalSetResultsManager?: EvalSetResultsManager;

  /** Defaults to {@link createEvalSessionId}. */
  sessionIdSupplier?: () => string;

  /** Defaults to a fresh `UserSimulatorProvider`. */
  userSimulatorProvider?: UserSimulatorProvider;

  /**
   * The app that wraps `rootAgent`. When given, its plugins, context cache
   * config and resumability config take part in the eval run.
   */
  app?: App;
}

/** Runs evals on the machine the service is constructed on. */
@experimental
export class LocalEvalService implements BaseEvalService {
  private readonly rootAgent: RunnableRoot;
  private readonly app?: App;
  private readonly evalSetsManager: EvalSetsManager;
  private readonly metricEvaluatorRegistry: MetricEvaluatorRegistry;
  private readonly sessionService: BaseSessionService;
  private readonly artifactService: BaseArtifactService;
  private readonly memoryService?: BaseMemoryService;
  private readonly evalSetResultsManager?: EvalSetResultsManager;
  private readonly sessionIdSupplier: () => string;
  private readonly userSimulatorProvider: UserSimulatorProvider;

  constructor(options: LocalEvalServiceOptions) {
    this.rootAgent = options.rootAgent;
    this.app = options.app;
    this.evalSetsManager = options.evalSetsManager;
    this.metricEvaluatorRegistry =
      options.metricEvaluatorRegistry ?? defaultMetricEvaluatorRegistry();
    this.sessionService =
      options.sessionService ?? new InMemorySessionService();
    this.artifactService =
      options.artifactService ?? new InMemoryArtifactService();
    this.memoryService = options.memoryService;
    this.evalSetResultsManager = options.evalSetResultsManager;
    this.sessionIdSupplier = options.sessionIdSupplier ?? createEvalSessionId;
    this.userSimulatorProvider =
      options.userSimulatorProvider ?? new UserSimulatorProvider();
  }

  /**
   * Runs the agent over the selected eval cases.
   *
   * @throws {NotFoundError} If the app has no eval set with that id.
   * @yields One result per eval case, in completion order. A case whose run
   *   threw is reported as a `FAILURE` result rather than aborting the batch.
   */
  async *performInference(
    inferenceRequest: InferenceRequest,
  ): AsyncGenerator<InferenceResult> {
    const {appName, evalSetId, evalCaseIds, inferenceConfig} = inferenceRequest;
    const evalSet = await this.evalSetsManager.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(
        `Eval set with id ${evalSetId} not found for app ${appName}`,
      );
    }

    // An empty list reads as "unspecified", the way Python's truthiness test
    // does, so it runs the whole set rather than nothing.
    const evalCases = evalCaseIds?.length
      ? evalSet.evalCases.filter((evalCase) =>
          evalCaseIds.includes(evalCase.evalId),
        )
      : evalSet.evalCases;

    yield* mapConcurrent(
      evalCases,
      inferenceConfig.parallelism ?? DEFAULT_EVAL_PARALLELISM,
      (evalCase) =>
        this.performInferenceForEvalCase(inferenceRequest, evalCase),
    );
  }

  /**
   * Scores each inference result against the configured metrics.
   *
   * Results are persisted once the stream drains, so a consumer that abandons
   * the generator early saves nothing.
   *
   * @throws {NotFoundError} If an inference result names an eval case the
   *   manager does not hold.
   * @throws {InputValidationError} If an eval case cannot be paired with its
   *   inferences, or a metric returns the wrong number of results.
   * @yields One result per inference result, in completion order.
   */
  async *evaluate(
    evaluateRequest: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult> {
    const {inferenceResults, evaluateConfig} = evaluateRequest;
    const resultsByEvalSet = new Map<
      string,
      {appName: string; evalCaseResults: EvalCaseResult[]}
    >();

    for await (const {inferenceResult, evalCaseResult} of mapConcurrent(
      inferenceResults,
      evaluateConfig.parallelism ?? DEFAULT_EVAL_PARALLELISM,
      async (inferenceResult) => ({
        inferenceResult,
        evalCaseResult: await this.evaluateInferenceResult(
          inferenceResult,
          evaluateConfig,
        ),
      }),
    )) {
      const group = resultsByEvalSet.get(inferenceResult.evalSetId) ?? {
        appName: inferenceResult.appName,
        evalCaseResults: [],
      };
      group.evalCaseResults.push(evalCaseResult);
      resultsByEvalSet.set(inferenceResult.evalSetId, group);
      yield evalCaseResult;
    }

    const evalSetResultsManager = this.evalSetResultsManager;
    if (!evalSetResultsManager) {
      return;
    }
    for (const [evalSetId, group] of resultsByEvalSet) {
      await evalSetResultsManager.saveEvalSetResult(
        group.appName,
        evalSetId,
        group.evalCaseResults,
      );
    }
  }

  private async performInferenceForEvalCase(
    inferenceRequest: InferenceRequest,
    evalCase: EvalCase,
  ): Promise<InferenceResult> {
    const {appName, evalSetId, inferenceConfig} = inferenceRequest;
    const initialSession = evalCase.sessionInput;
    const pinnedSessionId = initialSession?.sessionId;
    // The generator reads a pinned id off `initialSession`, so it is given an
    // id only when the case pins none.
    const generatedSessionId = pinnedSessionId
      ? undefined
      : this.sessionIdSupplier();
    const inferenceResult: InferenceResult = {
      appName,
      evalSetId,
      evalCaseId: evalCase.evalId,
      sessionId: pinnedSessionId ?? generatedSessionId,
      status: InferenceStatus.UNKNOWN,
    };

    try {
      const inferences = await runWithClientLabel(EVAL_CLIENT_LABEL, () => {
        const params = {
          rootAgent: this.rootAgent,
          userSimulator: this.userSimulatorProvider.provide(evalCase),
          initialSession,
          sessionId: generatedSessionId,
          sessionService: this.sessionService,
          artifactService: this.artifactService,
          memoryService: this.memoryService,
          app: this.app,
        };
        return inferenceConfig.useLive
          ? generateInferencesFromRootAgentLive({
              ...params,
              liveTimeoutSeconds:
                inferenceConfig.liveTimeoutSeconds ??
                DEFAULT_LIVE_TIMEOUT_SECONDS,
            })
          : generateInferencesFromRootAgent(params);
      });
      return {...inferenceResult, inferences, status: InferenceStatus.SUCCESS};
    } catch (e: unknown) {
      // A failing case must not abort the rest of the batch.
      const errorMessage = formatError(e);
      logger.error(
        `Inference failed for eval case \`${evalCase.evalId}\` with error ` +
          `${errorMessage}.`,
      );
      return {
        ...inferenceResult,
        status: InferenceStatus.FAILURE,
        errorMessage,
      };
    }
  }

  private async evaluateInferenceResult(
    inferenceResult: InferenceResult,
    evaluateConfig: EvaluateConfig,
  ): Promise<EvalCaseResult> {
    const {appName, evalSetId, evalCaseId} = inferenceResult;
    const evalCase = await this.evalSetsManager.getEvalCase(
      appName,
      evalSetId,
      evalCaseId,
    );
    if (evalCase === undefined) {
      throw new NotFoundError(
        `Eval case with id ${evalCaseId} not found for app ${appName} and ` +
          `eval set ${evalSetId}.`,
      );
    }

    const userId = evalCase.sessionInput?.userId || DEFAULT_EVAL_USER_ID;
    /** The fields both the failed and the scored result carry. */
    const base = {
      evalSetId,
      evalId: evalCaseId,
      sessionId: inferenceResult.sessionId ?? '',
      sessionDetails: await this.getSessionDetails(inferenceResult, userId),
      userId,
    };

    const actualInvocations = inferenceResult.inferences;
    if (actualInvocations === undefined) {
      return {
        ...base,
        finalEvalStatus: EvalStatus.FAILED,
        overallEvalMetricResults: [],
        evalMetricResultPerInvocation: [],
      };
    }

    const expectedInvocations = evalCase.conversation;
    if (expectedInvocations === undefined) {
      throw new InputValidationError(
        'A static eval case must provide an expected conversation.',
      );
    }
    if (actualInvocations.length !== expectedInvocations.length) {
      throw new InputValidationError(
        'Inferences should match conversations in eval case. Found ' +
          `${actualInvocations.length} inferences and ` +
          `${expectedInvocations.length} conversations in eval case.`,
      );
    }

    const evalMetricResultPerInvocation: EvalMetricResultPerInvocation[] =
      actualInvocations.map((actualInvocation, index) => ({
        actualInvocation,
        expectedInvocation: expectedInvocations[index],
        evalMetricResults: [],
      }));

    copyEvalCaseRubricsToActualInvocations(evalCase, actualInvocations);
    copyInvocationRubricsToActualInvocations(
      expectedInvocations,
      actualInvocations,
    );

    const overallEvalMetricResults: EvalMetricResult[] = [];
    for (const evalMetric of evaluateConfig.evalMetrics) {
      const evaluationResult = await this.evaluateMetric(
        evalMetric,
        evalCase,
        actualInvocations,
        expectedInvocations,
      );
      overallEvalMetricResults.push({
        ...evalMetric,
        score: evaluationResult.overallScore,
        evalStatus: evaluationResult.overallEvalStatus,
      });
      recordPerInvocationResults(
        evalMetric,
        evaluationResult,
        evalMetricResultPerInvocation,
      );
    }

    return {
      ...base,
      finalEvalStatus: generateFinalEvalStatus(overallEvalMetricResults),
      overallEvalMetricResults,
      evalMetricResultPerInvocation,
    };
  }

  /**
   * Scores one metric, degrading a failure to an unevaluated result so that
   * the remaining metrics still score.
   */
  private async evaluateMetric(
    evalMetric: EvalMetric,
    evalCase: EvalCase,
    actualInvocations: Invocation[],
    expectedInvocations: Invocation[],
  ): Promise<EvaluationResult> {
    try {
      return await runWithClientLabel(EVAL_CLIENT_LABEL, async () =>
        this.metricEvaluatorRegistry
          .getEvaluator(evalMetric)
          .evaluateInvocations(actualInvocations, expectedInvocations),
      );
    } catch (e: unknown) {
      logger.error(
        `Metric evaluation failed for metric \`${evalMetric.metricName}\` ` +
          `for eval case id '${evalCase.evalId}' with following error ` +
          `\`${formatError(e)}\`.`,
      );
      return emptyEvaluationResult();
    }
  }

  private async getSessionDetails(
    inferenceResult: InferenceResult,
    userId: string,
  ): Promise<Session | undefined> {
    if (inferenceResult.sessionId === undefined) {
      return undefined;
    }
    return this.sessionService.getSession({
      appName: inferenceResult.appName,
      userId,
      sessionId: inferenceResult.sessionId,
    });
  }
}

/**
 * Appends one metric result per invocation.
 *
 * An unevaluated metric produces an unevaluated entry for every invocation,
 * which is why it is allowed to return no per-invocation results at all.
 *
 * @throws {InputValidationError} If an evaluated metric returned a different
 *   number of results than there are invocations.
 */
function recordPerInvocationResults(
  evalMetric: EvalMetric,
  evaluationResult: EvaluationResult,
  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[],
): void {
  const evaluated =
    evaluationResult.overallEvalStatus !== EvalStatus.NOT_EVALUATED;
  if (
    evaluated &&
    evaluationResult.perInvocationResults.length !==
      evalMetricResultPerInvocation.length
  ) {
    throw new InputValidationError(
      'Eval metric should return results for each invocation. Found ' +
        `${evaluationResult.perInvocationResults.length} results for ` +
        `${evalMetricResultPerInvocation.length} invocations.`,
    );
  }

  evalMetricResultPerInvocation.forEach((perInvocation, index) => {
    const invocationResult = evaluated
      ? evaluationResult.perInvocationResults[index]
      : {evalStatus: EvalStatus.NOT_EVALUATED, score: undefined};
    perInvocation.evalMetricResults.push({
      ...evalMetric,
      score: invocationResult.score,
      evalStatus: invocationResult.evalStatus,
    });
  });
}
