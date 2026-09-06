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
import {
  emptyEvaluationResult,
  EvaluationResult,
  PerInvocationResult,
} from './evaluator.js';
import {
  defaultMetricEvaluatorRegistry,
  MetricEvaluatorRegistry,
} from './metric_evaluator_registry.js';
import {UserSimulatorProvider} from './simulation/user_simulator_provider.js';

/** Marks a session an eval run created, rather than a user session. */
export const EVAL_SESSION_ID_PREFIX = '___eval___session___';

/** The user an eval case runs as when it names none. */
const DEFAULT_EVAL_USER_ID = 'test_user_id';

/** Returns the id of a session an eval run owns. */
export function createEvalSessionId(): string {
  return `${EVAL_SESSION_ID_PREFIX}${randomUUID()}`;
}

/**
 * Folds the per-metric verdicts into the verdict for the whole eval case.
 *
 * One failing metric fails the case. A case whose metrics all went unevaluated
 * is itself `NOT_EVALUATED`.
 *
 * @throws {InputValidationError} On a status this fold does not know, which is
 *   how a newly added `EvalStatus` member surfaces.
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

/**
 * Records one metric's outcome, both overall and per invocation.
 *
 * @param perInvocation The entries to append to, one per actual invocation.
 * @throws {InputValidationError} When an evaluated metric returned a different
 *   number of per-invocation results than there are invocations.
 */
function recordMetricResults(
  evalMetric: EvalMetric,
  evaluationResult: EvaluationResult,
  perInvocation: EvalMetricResultPerInvocation[],
  overallEvalMetricResults: EvalMetricResult[],
): void {
  overallEvalMetricResults.push({
    ...evalMetric,
    score: evaluationResult.overallScore,
    evalStatus: evaluationResult.overallEvalStatus,
    details: {rubricScores: evaluationResult.overallRubricScores},
  });

  const evaluated =
    evaluationResult.overallEvalStatus !== EvalStatus.NOT_EVALUATED;
  if (
    evaluated &&
    evaluationResult.perInvocationResults.length !== perInvocation.length
  ) {
    throw new InputValidationError(
      'Eval metric should return results for each invocation. Found ' +
        `${evaluationResult.perInvocationResults.length} results for ` +
        `${perInvocation.length} invocations.`,
    );
  }

  perInvocation.forEach((entry, index) => {
    const invocationResult: PerInvocationResult = evaluated
      ? evaluationResult.perInvocationResults[index]
      : {
          actualInvocation: entry.actualInvocation,
          evalStatus: EvalStatus.NOT_EVALUATED,
        };
    entry.evalMetricResults.push({
      ...evalMetric,
      score: invocationResult.score,
      evalStatus: invocationResult.evalStatus,
      details: {rubricScores: invocationResult.rubricScores},
    });
  });
}

/** How a {@link LocalEvalService} runs and scores an eval. */
export interface LocalEvalServiceOptions {
  /** The agent under evaluation. */
  rootAgent: RunnableRoot;

  evalSetsManager: EvalSetsManager;

  /** Defaults to {@link defaultMetricEvaluatorRegistry}. */
  metricEvaluatorRegistry?: MetricEvaluatorRegistry;

  /** Defaults to a fresh `InMemorySessionService`. */
  sessionService?: BaseSessionService;

  /** Defaults to a fresh `InMemoryArtifactService`. */
  artifactService?: BaseArtifactService;

  /** Forwarded to the generator as given, which may be absent. */
  memoryService?: BaseMemoryService;

  /** When absent, results are yielded but never persisted. */
  evalSetResultsManager?: EvalSetResultsManager;

  /** Defaults to {@link createEvalSessionId}. */
  sessionIdSupplier?: () => string;

  /** Defaults to a fresh `UserSimulatorProvider`. */
  userSimulatorProvider?: UserSimulatorProvider;

  /**
   * The app wrapping `rootAgent`. When given, its plugins, context cache
   * config and resumability config take part in the run.
   */
  app?: App;
}

/**
 * Runs evals in this process.
 *
 * Inference and evaluation are separate phases: `performInference` drives the
 * agent over the cases of an eval set, and `evaluate` scores what it produced.
 * Both stream their results as each case completes, and both bound how many
 * cases run at a time.
 */
@experimental
export class LocalEvalService implements BaseEvalService {
  private readonly rootAgent: RunnableRoot;
  private readonly evalSetsManager: EvalSetsManager;
  private readonly metricEvaluatorRegistry: MetricEvaluatorRegistry;
  private readonly sessionService: BaseSessionService;
  private readonly artifactService: BaseArtifactService;
  private readonly memoryService?: BaseMemoryService;
  private readonly evalSetResultsManager?: EvalSetResultsManager;
  private readonly sessionIdSupplier: () => string;
  private readonly userSimulatorProvider: UserSimulatorProvider;
  private readonly app?: App;

  constructor(options: LocalEvalServiceOptions) {
    this.rootAgent = options.rootAgent;
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
    this.app = options.app;
  }

  /**
   * Yields one inference result per selected eval case, as each completes.
   *
   * A case whose run throws is yielded as a `FAILURE` result, so one bad case
   * does not abort the batch.
   *
   * @throws {NotFoundError} When the app has no eval set with that id.
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

    const evalCases = evalCaseIds?.length
      ? evalSet.evalCases.filter((evalCase) =>
          evalCaseIds.includes(evalCase.evalId),
        )
      : evalSet.evalCases;

    yield* mapConcurrent(
      evalCases,
      inferenceConfig.parallelism ?? DEFAULT_EVAL_PARALLELISM,
      (evalCase) =>
        this.runOneCase(appName, evalSetId, evalCase, inferenceConfig),
    );
  }

  /**
   * Yields one eval case result per inference result, as each completes.
   *
   * The results are persisted once the stream is drained, one save per eval
   * set. A consumer that abandons the stream saves nothing.
   *
   * @throws {NotFoundError} When an inference result names an eval case the
   *   eval set does not hold.
   */
  async *evaluate(
    evaluateRequest: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult> {
    const {inferenceResults, evaluateConfig} = evaluateRequest;
    const resultsBySet = new Map<
      string,
      {appName: string; evalCaseResults: EvalCaseResult[]}
    >();

    for await (const {inferenceResult, evalCaseResult} of mapConcurrent(
      inferenceResults,
      evaluateConfig.parallelism ?? DEFAULT_EVAL_PARALLELISM,
      (inferenceResult) => this.scoreOneResult(inferenceResult, evaluateConfig),
    )) {
      let group = resultsBySet.get(inferenceResult.evalSetId);
      if (!group) {
        group = {appName: inferenceResult.appName, evalCaseResults: []};
        resultsBySet.set(inferenceResult.evalSetId, group);
      }
      group.evalCaseResults.push(evalCaseResult);
      yield evalCaseResult;
    }

    const resultsManager = this.evalSetResultsManager;
    if (!resultsManager) {
      return;
    }
    for (const [evalSetId, {appName, evalCaseResults}] of resultsBySet) {
      await resultsManager.saveEvalSetResult(
        appName,
        evalSetId,
        evalCaseResults,
      );
    }
  }

  /** Runs one eval case, reporting a failure rather than throwing it. */
  private async runOneCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
    inferenceConfig: InferenceRequest['inferenceConfig'],
  ): Promise<InferenceResult> {
    const initialSession = evalCase.sessionInput;
    const pinnedSessionId = initialSession?.sessionId;
    // Only a fallback: the generator reads a pinned id from `initialSession`.
    const generatedSessionId = pinnedSessionId
      ? undefined
      : this.sessionIdSupplier();
    const base = {
      appName,
      evalSetId,
      evalCaseId: evalCase.evalId,
      // Python's truthiness test: an empty pinned id falls through as well.
      sessionId: pinnedSessionId || generatedSessionId,
    };

    try {
      // The provider rejects a case it cannot drive, so it runs here: that
      // rejection is this case's failure, not the whole batch's.
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
      const inferences = await runWithClientLabel(EVAL_CLIENT_LABEL, () =>
        inferenceConfig.useLive
          ? generateInferencesFromRootAgentLive({
              ...params,
              liveTimeoutSeconds:
                inferenceConfig.liveTimeoutSeconds ??
                DEFAULT_LIVE_TIMEOUT_SECONDS,
            })
          : generateInferencesFromRootAgent(params),
      );
      return {...base, inferences, status: InferenceStatus.SUCCESS};
    } catch (e: unknown) {
      const errorMessage = formatError(e);
      logger.error(
        `Inference failed for eval case \`${evalCase.evalId}\` with error ` +
          `${errorMessage}.`,
      );
      return {...base, status: InferenceStatus.FAILURE, errorMessage};
    }
  }

  /**
   * Scores one inference result against every configured metric.
   *
   * @returns The inference result with its score, paired because grouping the
   *   saved results needs the eval set the inference came from.
   */
  private async scoreOneResult(
    inferenceResult: InferenceResult,
    evaluateConfig: EvaluateConfig,
  ): Promise<{
    inferenceResult: InferenceResult;
    evalCaseResult: EvalCaseResult;
  }> {
    const {appName, evalSetId, evalCaseId, sessionId} = inferenceResult;
    const evalCase = await this.evalSetsManager.getEvalCase(
      appName,
      evalSetId,
      evalCaseId,
    );
    if (!evalCase) {
      throw new NotFoundError(
        `Eval case with id ${evalCaseId} not found for app ${appName} and ` +
          `eval set ${evalSetId}.`,
      );
    }

    // Python's truthiness test: an empty user id falls back too.
    const userId = evalCase.sessionInput?.userId || DEFAULT_EVAL_USER_ID;
    const sessionDetails = await this.getSessionDetails(
      appName,
      userId,
      sessionId,
    );
    const base = {
      evalSetFile: evalSetId,
      evalSetId,
      evalId: evalCaseId,
      sessionId: sessionId ?? '',
      sessionDetails,
      userId,
    };

    const actualInvocations = inferenceResult.inferences;
    if (actualInvocations === undefined) {
      return {
        inferenceResult,
        evalCaseResult: {
          ...base,
          finalEvalStatus: EvalStatus.FAILED,
          overallEvalMetricResults: [],
          evalMetricResultPerInvocation: [],
        },
      };
    }

    const expectedInvocations = evalCase.conversation;
    if (evalCase.conversationScenario === undefined) {
      validateStaticPairing(actualInvocations, expectedInvocations);
    }

    const evalMetricResultPerInvocation: EvalMetricResultPerInvocation[] =
      actualInvocations.map((actualInvocation, index) => ({
        actualInvocation,
        expectedInvocation: expectedInvocations?.[index],
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
      );
      recordMetricResults(
        evalMetric,
        evaluationResult,
        evalMetricResultPerInvocation,
        overallEvalMetricResults,
      );
    }

    return {
      inferenceResult,
      evalCaseResult: {
        ...base,
        finalEvalStatus: generateFinalEvalStatus(overallEvalMetricResults),
        overallEvalMetricResults,
        evalMetricResultPerInvocation,
      },
    };
  }

  /** The session an inference ran in, when it recorded one. */
  private async getSessionDetails(
    appName: string,
    userId: string,
    sessionId: string | undefined,
  ): Promise<Session | undefined> {
    if (sessionId === undefined) {
      return undefined;
    }
    return this.sessionService.getSession({appName, userId, sessionId});
  }

  /**
   * Scores one metric, degrading a failure to an unevaluated result.
   *
   * A metric that cannot be resolved, rejects its input, or fails against the
   * model must not stop the other metrics of the same eval case.
   */
  private async evaluateMetric(
    evalMetric: EvalMetric,
    evalCase: EvalCase,
    actualInvocations: Invocation[],
  ): Promise<EvaluationResult> {
    try {
      return await runWithClientLabel(EVAL_CLIENT_LABEL, () => {
        const evaluator = this.metricEvaluatorRegistry.getEvaluator(evalMetric);
        return evaluator.evaluateInvocations(
          actualInvocations,
          evalCase.conversation,
          evalCase.conversationScenario,
        );
      });
    } catch (e: unknown) {
      logger.error(
        `Metric evaluation failed for metric \`${evalMetric.metricName}\` ` +
          `for eval case id '${evalCase.evalId}' with following error ` +
          `\`${formatError(e)}\``,
      );
      return emptyEvaluationResult();
    }
  }
}

/**
 * Rejects a static eval case whose golden turns cannot be paired with the
 * inferences.
 *
 * @throws {InputValidationError} When the case has no expected conversation,
 *   or when the two lists differ in length.
 */
function validateStaticPairing(
  actualInvocations: Invocation[],
  expectedInvocations: Invocation[] | undefined,
): void {
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
}
