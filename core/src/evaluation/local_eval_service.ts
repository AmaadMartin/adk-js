/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from '../agents/base_agent.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {InMemoryArtifactService} from '../artifacts/in_memory_artifact_service.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {Session} from '../sessions/session.js';
import {runWithClientLabel} from '../utils/client_labels.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {version} from '../version.js';

import {
  BaseEvalService,
  EvaluateConfig,
  EvaluateRequest,
  InferenceRequest,
  InferenceResult,
  InferenceStatus,
} from './base_eval_service.js';
import {EvalCase, Invocation} from './eval_case.js';
import {
  EvalMetric,
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalStatus,
} from './eval_metrics.js';
import {EvalCaseResult} from './eval_result.js';
import {Rubric} from './eval_rubrics.js';
import {EvalSetResultsManager} from './eval_set_results_manager.js';
import {EvalSetsManager} from './eval_sets_manager.js';
import {
  DEFAULT_EVAL_USER_ID,
  EvaluationGenerator,
} from './evaluation_generator.js';
import {EvaluationResult, PerInvocationResult} from './evaluator.js';
import {
  DEFAULT_METRIC_EVALUATOR_REGISTRY,
  MetricEvaluatorRegistry,
} from './metric_evaluator_registry.js';
import {UserSimulatorProvider} from './simulation/user_simulator_provider.js';

/** Prefix applied to session ids generated for eval runs. */
export const EVAL_SESSION_ID_PREFIX = '___eval___session___';

/** Client label attached to LLM calls made during eval, for billing/telemetry. */
const EVAL_CLIENT_LABEL = `google-adk-eval/${version}`;

/** Message thrown when live inference is requested (not yet supported). */
const LIVE_INFERENCE_NOT_SUPPORTED_MESSAGE =
  'Live (bidi-streaming) inference is not yet supported in adk-js; use' +
  ' non-live inference by setting inferenceConfig.useLive to false.';

// The default user id is owned by `evaluation_generator.ts`, which creates the
// eval session; the session lookup below only succeeds while both agree.

/** Returns a fresh eval session id. */
export function getSessionId(): string {
  return `${EVAL_SESSION_ID_PREFIX}${randomUUID()}`;
}

/**
 * Adds rubrics to an invocation, initializing the list if needed.
 *
 * @throws {Error} If a rubric with a duplicate `rubricId` is added.
 */
export function addRubricsToInvocation(
  invocation: Invocation,
  rubricsToAdd: Rubric[],
): void {
  invocation.rubrics ??= [];
  const existingIds = new Set(
    invocation.rubrics.map((rubric) => rubric.rubricId),
  );
  for (const rubric of rubricsToAdd) {
    if (existingIds.has(rubric.rubricId)) {
      throw new Error(
        `Rubric with rubric_id '${rubric.rubricId}' already exists.`,
      );
    }
    invocation.rubrics.push(rubric);
    existingIds.add(rubric.rubricId);
  }
}

/** Copies eval-case-level rubrics onto every actual invocation. */
export function copyEvalCaseRubricsToActualInvocations(
  evalCase: EvalCase,
  actualInvocations: Invocation[],
): void {
  if (evalCase.rubrics && evalCase.rubrics.length > 0) {
    for (const invocation of actualInvocations) {
      addRubricsToInvocation(invocation, evalCase.rubrics);
    }
  }
}

/** Copies invocation-level rubrics onto the index-aligned actual invocations. */
export function copyInvocationRubricsToActualInvocations(
  expectedInvocations: Invocation[] | undefined,
  actualInvocations: Invocation[],
): void {
  if (!expectedInvocations) {
    return;
  }
  const count = Math.min(actualInvocations.length, expectedInvocations.length);
  for (let i = 0; i < count; i++) {
    const expected = expectedInvocations[i];
    if (expected.rubrics && expected.rubrics.length > 0) {
      addRubricsToInvocation(actualInvocations[i], expected.rubrics);
    }
  }
}

/**
 * Derives the case-level eval status from the per-metric overall statuses.
 *
 * PASSED if any metric passed and none failed; FAILED short-circuits;
 * NOT_EVALUATED is skipped.
 *
 * @throws {Error} If an unknown {@link EvalStatus} is encountered.
 */
export function generateFinalEvalStatus(
  overallEvalMetricResults: EvalMetricResult[],
): EvalStatus {
  let finalEvalStatus: EvalStatus = EvalStatus.NOT_EVALUATED;
  for (const result of overallEvalMetricResults) {
    const overallEvalStatus = result.evalStatus;
    if (overallEvalStatus === EvalStatus.PASSED) {
      finalEvalStatus = EvalStatus.PASSED;
    } else if (overallEvalStatus === EvalStatus.NOT_EVALUATED) {
      continue;
    } else if (overallEvalStatus === EvalStatus.FAILED) {
      finalEvalStatus = EvalStatus.FAILED;
      break;
    } else {
      throw new Error(`Unknown eval status: ${overallEvalStatus}.`);
    }
  }
  return finalEvalStatus;
}

/** Case results accumulated for a single (app, eval set) pair. */
interface EvalSetResultGroup {
  appName: string;
  evalSetId: string;
  cases: EvalCaseResult[];
}

/**
 * Returns the grouping key for an (app, eval set) pair. Results are saved per
 * pair, so two apps that share an eval set id stay separate. NUL cannot appear
 * in either id, so the key is unambiguous.
 */
function resultGroupKey(appName: string, evalSetId: string): string {
  return `${appName}\u0000${evalSetId}`;
}

/**
 * Runs `fn` over `items` with at most `limit` concurrent executions, yielding
 * each result as soon as it settles (completion order, not input order).
 *
 * The first rejection is propagated to the consumer; in-flight siblings are
 * abandoned but never surface as unhandled rejections.
 */
async function* mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  // A comparison against NaN is always false, so `Math.max` would leave the
  // limit NaN and silently starve the pool; treat any non-positive or
  // non-numeric limit as 1.
  const effectiveLimit = limit >= 1 ? Math.floor(limit) : 1;
  interface Settled {
    index: number;
    ok: boolean;
    result?: R;
    error?: unknown;
  }
  const executing = new Map<number, Promise<Settled>>();
  let nextIndex = 0;

  const startNext = (): void => {
    const index = nextIndex++;
    const promise = fn(items[index]).then(
      (result): Settled => ({index, ok: true, result}),
      (error): Settled => ({index, ok: false, error}),
    );
    executing.set(index, promise);
  };

  while (nextIndex < items.length && executing.size < effectiveLimit) {
    startNext();
  }

  while (executing.size > 0) {
    const settled = await Promise.race(executing.values());
    executing.delete(settled.index);
    if (!settled.ok) {
      throw settled.error;
    }
    if (nextIndex < items.length) {
      startNext();
    }
    yield settled.result as R;
  }
}

/** Options for constructing a {@link LocalEvalService}. */
export interface LocalEvalServiceOptions {
  /** The agent to run over each eval case. */
  rootAgent: BaseAgent;
  /** Manager used to read eval sets and eval cases. */
  evalSetsManager: EvalSetsManager;
  /** Registry of metric evaluators. Defaults to the built-in registry. */
  metricEvaluatorRegistry?: MetricEvaluatorRegistry;
  /** Session service used for inference. Defaults to an in-memory service. */
  sessionService?: BaseSessionService;
  /** Artifact service used for inference. Defaults to an in-memory service. */
  artifactService?: BaseArtifactService;
  /** Optional manager used to persist eval-set-level results. */
  evalSetResultsManager?: EvalSetResultsManager;
  /** Supplies session ids for inference. Defaults to {@link getSessionId}. */
  sessionIdSupplier?: () => string;
  /** Provides a user simulator per eval case. */
  userSimulatorProvider?: UserSimulatorProvider;
  /** Optional memory service used for inference. */
  memoryService?: BaseMemoryService;
}

/**
 * A {@link BaseEvalService} implementation that runs evals locally.
 *
 * `performInference` runs the agent over an eval set and streams one
 * {@link InferenceResult} per case as it completes; `evaluate` scores those
 * inferences and streams one {@link EvalCaseResult} per inference. Both bound
 * their concurrency by the request's `parallelism`.
 */
@experimental
export class LocalEvalService extends BaseEvalService {
  private readonly rootAgent: BaseAgent;
  private readonly evalSetsManager: EvalSetsManager;
  private readonly metricEvaluatorRegistry: MetricEvaluatorRegistry;
  private readonly sessionService: BaseSessionService;
  private readonly artifactService: BaseArtifactService;
  private readonly evalSetResultsManager?: EvalSetResultsManager;
  private readonly sessionIdSupplier: () => string;
  private readonly userSimulatorProvider: UserSimulatorProvider;
  private readonly memoryService?: BaseMemoryService;

  constructor(options: LocalEvalServiceOptions) {
    super();
    this.rootAgent = options.rootAgent;
    this.evalSetsManager = options.evalSetsManager;
    this.metricEvaluatorRegistry =
      options.metricEvaluatorRegistry ?? DEFAULT_METRIC_EVALUATOR_REGISTRY;
    this.sessionService =
      options.sessionService ?? new InMemorySessionService();
    this.artifactService =
      options.artifactService ?? new InMemoryArtifactService();
    this.evalSetResultsManager = options.evalSetResultsManager;
    this.sessionIdSupplier = options.sessionIdSupplier ?? getSessionId;
    this.userSimulatorProvider =
      options.userSimulatorProvider ?? new UserSimulatorProvider();
    this.memoryService = options.memoryService;
  }

  override async *performInference(
    inferenceRequest: InferenceRequest,
  ): AsyncGenerator<InferenceResult> {
    const {appName, evalSetId, evalCaseIds, inferenceConfig} = inferenceRequest;

    const evalSet = await this.evalSetsManager.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(
        `Eval set with id ${evalSetId} not found for app ${appName}`,
      );
    }

    let evalCases = evalSet.evalCases;
    if (evalCaseIds) {
      evalCases = evalCases.filter((evalCase) =>
        evalCaseIds.includes(evalCase.evalId),
      );
    }

    if (inferenceConfig.useLive) {
      throw new Error(LIVE_INFERENCE_NOT_SUPPORTED_MESSAGE);
    }

    yield* mapWithConcurrency(
      evalCases,
      inferenceConfig.parallelism,
      (evalCase) =>
        this.performInferenceSingleEvalItem({appName, evalSetId, evalCase}),
    );
  }

  override async *evaluate(
    evaluateRequest: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult> {
    const {inferenceResults, evaluateConfig} = evaluateRequest;

    const resultsBySet = new Map<string, EvalSetResultGroup>();

    const stream = mapWithConcurrency(
      inferenceResults,
      evaluateConfig.parallelism,
      (inferenceResult) =>
        this.evaluateSingleInferenceResult(inferenceResult, evaluateConfig),
    );

    try {
      for await (const [inferenceResult, evalCaseResult] of stream) {
        const {appName, evalSetId} = inferenceResult;
        const group = resultsBySet.get(resultGroupKey(appName, evalSetId));
        if (group === undefined) {
          resultsBySet.set(resultGroupKey(appName, evalSetId), {
            appName,
            evalSetId,
            cases: [evalCaseResult],
          });
        } else {
          group.cases.push(evalCaseResult);
        }
        yield evalCaseResult;
      }
    } catch (error) {
      // Persist what already scored before surfacing the failure; otherwise a
      // single failing eval case discards every result computed so far.
      await this.saveEvalSetResults(resultsBySet);
      throw error;
    }

    await this.saveEvalSetResults(resultsBySet);
  }

  /**
   * Saves the accumulated case results, one call per (app, eval set) pair.
   *
   * Only reached on normal completion or on a failure of the stream; a
   * consumer that abandons the generator early saves nothing.
   */
  private async saveEvalSetResults(
    resultsBySet: Map<string, EvalSetResultGroup>,
  ): Promise<void> {
    if (!this.evalSetResultsManager) {
      return;
    }
    for (const {appName, evalSetId, cases} of resultsBySet.values()) {
      await this.evalSetResultsManager.saveEvalSetResult(
        appName,
        evalSetId,
        cases,
      );
    }
  }

  private async evaluateSingleInferenceResult(
    inferenceResult: InferenceResult,
    evaluateConfig: EvaluateConfig,
  ): Promise<[InferenceResult, EvalCaseResult]> {
    const {appName, evalSetId, evalCaseId} = inferenceResult;

    const evalCase = await this.evalSetsManager.getEvalCase(
      appName,
      evalSetId,
      evalCaseId,
    );
    // Data-consistency problems (a missing eval case, or inferences that do not
    // line up with the recorded conversation below) fail fast rather than
    // degrade to a FAILED result: they mean the eval set itself is inconsistent
    // with the inferences it is being scored against, and reporting them as
    // ordinary failed cases would hide that behind what looks like a bad model
    // run. Runtime failures — a flaky inference or a throwing metric — stay
    // isolated per item, as the sibling paths below do. Results already scored
    // are still persisted; see `evaluate`.
    if (evalCase == null) {
      throw new NotFoundError(
        `Eval case with id ${evalCaseId} not found for app ${appName} and` +
          ` eval set ${evalSetId}.`,
      );
    }

    const userId = evalCase.sessionInput?.userId ?? DEFAULT_EVAL_USER_ID;

    if (inferenceResult.inferences == null) {
      let sessionDetails: Session | undefined;
      if (inferenceResult.sessionId != null) {
        sessionDetails = await this.sessionService.getSession({
          appName,
          userId,
          sessionId: inferenceResult.sessionId,
        });
      }
      return [
        inferenceResult,
        {
          evalSetFile: evalSetId,
          evalSetId,
          evalId: evalCaseId,
          finalEvalStatus: EvalStatus.FAILED,
          overallEvalMetricResults: [],
          evalMetricResultPerInvocation: [],
          sessionId: inferenceResult.sessionId ?? '',
          sessionDetails,
          userId,
        },
      ];
    }

    const inferences = inferenceResult.inferences;
    if (
      evalCase.conversationScenario == null &&
      inferences.length !== (evalCase.conversation?.length ?? 0)
    ) {
      throw new Error(
        'Inferences should match conversations in eval case. Found ' +
          `${inferences.length} inferences and ` +
          `${evalCase.conversation?.length ?? 0} conversations in eval cases.`,
      );
    }

    const evalMetricResultPerInvocation: EvalMetricResultPerInvocation[] =
      inferences.map((actual, idx) => ({
        actualInvocation: actual,
        expectedInvocation: evalCase.conversation?.[idx],
        evalMetricResults: [],
      }));

    const actualInvocations = inferences;
    const expectedInvocations = evalCase.conversation;

    // 1. Copy eval-case-level rubrics onto all actual invocations.
    copyEvalCaseRubricsToActualInvocations(evalCase, actualInvocations);
    // 2. Copy invocation-level rubrics onto the aligned actual invocations.
    copyInvocationRubricsToActualInvocations(
      expectedInvocations,
      actualInvocations,
    );

    const overallEvalMetricResults: EvalMetricResult[] = [];
    for (const evalMetric of evaluateConfig.evalMetrics) {
      await this.evaluateMetricForEvalCase(
        evalMetric,
        evalCase,
        actualInvocations,
        evalMetricResultPerInvocation,
        overallEvalMetricResults,
      );
    }

    const finalEvalStatus = generateFinalEvalStatus(overallEvalMetricResults);
    const sessionId = inferenceResult.sessionId;
    const sessionDetails =
      sessionId != null
        ? await this.sessionService.getSession({appName, userId, sessionId})
        : undefined;

    const evalCaseResult: EvalCaseResult = {
      evalSetFile: evalSetId,
      evalSetId,
      evalId: evalCaseId,
      finalEvalStatus,
      overallEvalMetricResults,
      evalMetricResultPerInvocation,
      sessionId: sessionId ?? '',
      sessionDetails,
      userId,
    };

    return [inferenceResult, evalCaseResult];
  }

  private async evaluateMetricForEvalCase(
    evalMetric: EvalMetric,
    evalCase: EvalCase,
    actualInvocations: Invocation[],
    evalMetricResultPerInvocation: EvalMetricResultPerInvocation[],
    overallEvalMetricResults: EvalMetricResult[],
  ): Promise<void> {
    let evaluationResult: EvaluationResult;
    try {
      // `await` handles both sync and async evaluators, so no reflection is
      // needed (unlike adk-python's `inspect.iscoroutinefunction` branch).
      evaluationResult = await runWithClientLabel(EVAL_CLIENT_LABEL, () =>
        this.metricEvaluatorRegistry
          .getEvaluator(evalMetric)
          .evaluateInvocations(
            actualInvocations,
            evalCase.conversation,
            evalCase.conversationScenario,
          ),
      );
    } catch (error) {
      // A single metric failure must not abort other metrics or eval cases.
      logger.error(
        `Metric evaluation failed for metric \`${evalMetric.metricName}\` for` +
          ` eval case id '${evalCase.evalId}' with following error` +
          ` \`${error}\`.`,
      );
      evaluationResult = {
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      };
    }

    overallEvalMetricResults.push({
      ...evalMetric,
      score: evaluationResult.overallScore,
      evalStatus: evaluationResult.overallEvalStatus,
      details: {rubricScores: evaluationResult.overallRubricScores},
    });

    if (
      evaluationResult.overallEvalStatus !== EvalStatus.NOT_EVALUATED &&
      evaluationResult.perInvocationResults.length !==
        evalMetricResultPerInvocation.length
    ) {
      throw new Error(
        'Eval metric should return results for each invocation. Found ' +
          `${evaluationResult.perInvocationResults.length} results for ` +
          `${evalMetricResultPerInvocation.length} invocations.`,
      );
    }

    evalMetricResultPerInvocation.forEach((invocation, idx) => {
      const invocationResult: PerInvocationResult =
        evaluationResult.overallEvalStatus !== EvalStatus.NOT_EVALUATED
          ? evaluationResult.perInvocationResults[idx]
          : {
              actualInvocation: invocation.actualInvocation,
              evalStatus: EvalStatus.NOT_EVALUATED,
            };
      invocation.evalMetricResults.push({
        ...evalMetric,
        score: invocationResult.score,
        evalStatus: invocationResult.evalStatus,
        details: {rubricScores: invocationResult.rubricScores},
      });
    });
  }

  private async performInferenceSingleEvalItem({
    appName,
    evalSetId,
    evalCase,
  }: {
    appName: string;
    evalSetId: string;
    evalCase: EvalCase;
  }): Promise<InferenceResult> {
    const initialSession = evalCase.sessionInput;
    const sessionId = this.sessionIdSupplier();
    const inferenceResult: InferenceResult = {
      appName,
      evalSetId,
      evalCaseId: evalCase.evalId,
      sessionId,
      status: InferenceStatus.UNKNOWN,
    };

    try {
      const inferences = await runWithClientLabel(EVAL_CLIENT_LABEL, () =>
        EvaluationGenerator.generateInferencesFromRootAgent({
          rootAgent: this.rootAgent,
          userSimulator: this.userSimulatorProvider.provide(evalCase),
          // The session must be created under the app name the evaluation
          // stage reads it back with, otherwise `sessionDetails` silently
          // resolves to undefined.
          appName,
          initialSession,
          sessionId,
          sessionService: this.sessionService,
          artifactService: this.artifactService,
          memoryService: this.memoryService,
        }),
      );
      inferenceResult.inferences = inferences;
      inferenceResult.status = InferenceStatus.SUCCESS;
      return inferenceResult;
    } catch (error) {
      // A single inference failure must not affect other inferences.
      logger.error(
        `Inference failed for eval case \`${evalCase.evalId}\` with error` +
          ` ${error}.`,
      );
      inferenceResult.status = InferenceStatus.FAILURE;
      inferenceResult.errorMessage = String(error);
      return inferenceResult;
    }
  }
}
