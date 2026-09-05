/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseArtifactService,
  BaseSessionService,
  convertEventsToEvalInvocations,
  defaultMetricEvaluatorRegistry,
  EvalCase,
  EvalCaseResult,
  EvalConfig,
  EvalMetric,
  EvalSet,
  EvalSetResult,
  EvalSetResultsManager,
  EvalSetsManager,
  EvalStatus,
  getEvalRuntime,
  InferenceResult,
  isApp,
  isBaseAgent,
  Logger,
  MetricInfo,
  MISSING_EVAL_DEPENDENCIES_MESSAGE,
} from '@google/adk';
import express, {Request, Response} from 'express';

import {AgentLoader} from '../utils/agent_loader.js';
import {createEmptyState} from '../utils/agent_state.js';
import {errorMessage} from '../utils/error_utils.js';

/** Body of `POST /dev/apps/:appName/eval-sets`. */
export interface CreateEvalSetRequest {
  evalSet: {evalSetId: string};
}

/** Body of `GET /dev/apps/:appName/eval-sets`. */
export interface ListEvalSetsResponse {
  evalSetIds: string[];
}

/** Body of `POST /dev/apps/:appName/eval-sets/:evalSetId/add-session`. */
export interface AddSessionToEvalSetRequest {
  evalId: string;
  sessionId: string;
  userId: string;
}

/** Body of `GET /dev/apps/:appName/eval-results`. */
export interface ListEvalResultsResponse {
  evalResultIds: string[];
}

/** Body of `GET /dev/apps/:appName/metrics-info`. */
export interface ListMetricsInfoResponse {
  metricsInfo: MetricInfo[];
}

/** Body of `POST /dev/apps/:appName/eval-sets/:evalSetId/run`. */
export interface RunEvalRequest {
  evalIds?: string[];
  evalMetrics?: EvalMetric[];
}

/** The result of scoring one eval case. */
export interface RunEvalResult {
  evalSetFile?: string;
  evalSetId: string;
  evalId: string;
  finalEvalStatus: EvalStatus;
  overallEvalMetricResults: EvalCaseResult['overallEvalMetricResults'];
  evalMetricResultPerInvocation: EvalCaseResult['evalMetricResultPerInvocation'];
  userId?: string;
  sessionId: string;
}

/** Body of the two run-eval routes. */
export interface RunEvalResponse {
  runEvalResults: RunEvalResult[];
}

/** Everything the eval routes read from the server that registers them. */
export interface EvalRouteDependencies {
  evalSetsManager: EvalSetsManager;
  evalSetResultsManager: EvalSetResultsManager;
  sessionService: BaseSessionService;
  artifactService: BaseArtifactService;
  agentLoader: AgentLoader;
  logger: Logger;
}

/**
 * Registers the eval-set and eval-result endpoints the developer UI drives.
 *
 * adk-python puts these on a `DevServer` subclass of its `ApiServer`; adk-js
 * has one server class, so the caller decides when to register them. It
 * registers each dev-UI path alongside the `/apps/...` path adk-js already
 * answered with 501, so a client on either path is served.
 */
export function registerEvalRoutes(
  app: express.Application,
  deps: EvalRouteDependencies,
  options: {serveDebugUI: boolean},
): void {
  const handlers = new EvalRouteHandlers(deps);

  // The paths adk-js already registered, which answered 501. They stay on
  // every server, because a client may already be calling them.
  app.post('/apps/:appName/eval_sets/:evalSetId', (req, res) =>
    handlers.createEvalSetLegacy(req, res),
  );
  app.get('/apps/:appName/eval_sets', (req, res) =>
    handlers.listEvalSetsLegacy(req, res),
  );
  app.post('/apps/:appName/eval_sets/:evalSetId/add_session', (req, res) =>
    handlers.addSessionToEvalSet(req, res),
  );
  app.get('/apps/:appName/eval_sets/:evalSetId/evals', (req, res) =>
    handlers.listEvalsInEvalSet(req, res),
  );
  app.get(LEGACY_EVAL_CASE_PATH, (req, res) => handlers.getEval(req, res));
  app.put(LEGACY_EVAL_CASE_PATH, (req, res) => handlers.updateEval(req, res));
  app.delete(LEGACY_EVAL_CASE_PATH, (req, res) =>
    handlers.deleteEval(req, res),
  );
  app.post('/apps/:appName/eval_sets/:evalSetId/run_eval', (req, res) =>
    handlers.runEvalLegacy(req, res),
  );
  app.get('/apps/:appName/eval_results/:evalResultId', (req, res) =>
    handlers.getEvalResult(req, res),
  );
  app.get('/apps/:appName/eval_results', (req, res) =>
    handlers.listEvalResultsLegacy(req, res),
  );
  app.get('/apps/:appName/eval_metrics', (req, res) =>
    handlers.listMetricsInfo(req, res),
  );

  if (!options.serveDebugUI) {
    return;
  }

  // The paths the developer UI asks under. adk-python serves only these, from
  // its `DevServer`, so `adk api_server` does not grow them here either.
  app.post('/dev/apps/:appName/eval-sets', (req, res) =>
    handlers.createEvalSet(req, res),
  );
  app.post('/dev/apps/:appName/eval_sets/:evalSetId', (req, res) =>
    handlers.createEvalSetLegacy(req, res),
  );
  app.get('/dev/apps/:appName/eval-sets', (req, res) =>
    handlers.listEvalSets(req, res),
  );
  app.get('/dev/apps/:appName/eval_sets', (req, res) =>
    handlers.listEvalSetsLegacy(req, res),
  );
  app.post(
    [
      '/dev/apps/:appName/eval-sets/:evalSetId/add-session',
      '/dev/apps/:appName/eval_sets/:evalSetId/add_session',
    ],
    (req, res) => handlers.addSessionToEvalSet(req, res),
  );
  app.get('/dev/apps/:appName/eval_sets/:evalSetId/evals', (req, res) =>
    handlers.listEvalsInEvalSet(req, res),
  );
  app.get(DEV_EVAL_CASE_PATHS, (req, res) => handlers.getEval(req, res));
  app.put(DEV_EVAL_CASE_PATHS, (req, res) => handlers.updateEval(req, res));
  app.delete(DEV_EVAL_CASE_PATHS, (req, res) => handlers.deleteEval(req, res));
  app.post('/dev/apps/:appName/eval-sets/:evalSetId/run', (req, res) =>
    handlers.runEval(req, res),
  );
  app.post('/dev/apps/:appName/eval_sets/:evalSetId/run_eval', (req, res) =>
    handlers.runEvalLegacy(req, res),
  );
  app.get(
    [
      '/dev/apps/:appName/eval-results/:evalResultId',
      '/dev/apps/:appName/eval_results/:evalResultId',
    ],
    (req, res) => handlers.getEvalResult(req, res),
  );
  app.get('/dev/apps/:appName/eval-results', (req, res) =>
    handlers.listEvalResults(req, res),
  );
  app.get('/dev/apps/:appName/eval_results', (req, res) =>
    handlers.listEvalResultsLegacy(req, res),
  );
  app.get('/dev/apps/:appName/metrics-info', (req, res) =>
    handlers.listMetricsInfo(req, res),
  );
}

/** The path adk-js already answered for one eval case. */
const LEGACY_EVAL_CASE_PATH =
  '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId';

/** The two developer-UI paths that address one eval case. */
const DEV_EVAL_CASE_PATHS = [
  '/dev/apps/:appName/eval-sets/:evalSetId/eval-cases/:evalCaseId',
  '/dev/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
];

/** HTTP status a thrown value maps to, by the error's name. */
const STATUS_BY_ERROR_NAME: Record<string, number> = {
  InputValidationError: 400,
  AlreadyExistsError: 400,
  NotFoundError: 404,
};

/**
 * `add-session` names the eval set in the request rather than addressing it,
 * so an eval set that does not exist is a bad request and not a missing
 * resource. adk-python answers 400 there too.
 */
const ADD_SESSION_STATUS_BY_ERROR_NAME: Record<string, number> = {
  ...STATUS_BY_ERROR_NAME,
  NotFoundError: 400,
};

/**
 * Reads the `name` an ADK error class sets on itself. Matched by name and not
 * with `instanceof`, so an error thrown by a second copy of `@google/adk` in
 * the same process still maps to its status.
 */
function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/**
 * The eval handlers, holding the managers and services they all need.
 *
 * They are methods rather than module functions because every one of them
 * reads the same set of injected dependencies.
 */
class EvalRouteHandlers {
  constructor(private readonly deps: EvalRouteDependencies) {}

  async createEvalSet(req: Request, res: Response): Promise<void> {
    const body = req.body as CreateEvalSetRequest;
    const evalSetId = body?.evalSet?.evalSetId;
    if (!evalSetId) {
      this.fail(res, 400, 'evalSet.evalSetId is required.');
      return;
    }
    await this.answer(res, () =>
      this.deps.evalSetsManager.createEvalSet(req.params['appName'], evalSetId),
    );
  }

  /** Creates an eval set named by the path, as the deprecated route does. */
  async createEvalSetLegacy(req: Request, res: Response): Promise<void> {
    await this.answer(res, () =>
      this.deps.evalSetsManager.createEvalSet(
        req.params['appName'],
        req.params['evalSetId'],
      ),
    );
  }

  async listEvalSets(req: Request, res: Response): Promise<void> {
    const evalSetIds = await this.listEvalSetIds(req.params['appName']);
    res.json({evalSetIds} satisfies ListEvalSetsResponse);
  }

  async listEvalSetsLegacy(req: Request, res: Response): Promise<void> {
    res.json(await this.listEvalSetIds(req.params['appName']));
  }

  /**
   * An app with no eval sets at all reads as an empty list rather than an
   * error, matching adk-python, which logs the `NotFoundError` and returns
   * the empty list it started from.
   */
  private async listEvalSetIds(appName: string): Promise<string[]> {
    try {
      return await this.deps.evalSetsManager.listEvalSets(appName);
    } catch (error: unknown) {
      this.deps.logger.warn(errorMessage(error));
      return [];
    }
  }

  async addSessionToEvalSet(req: Request, res: Response): Promise<void> {
    const appName = req.params['appName'];
    const evalSetId = req.params['evalSetId'];
    const body = req.body as AddSessionToEvalSetRequest;

    const session = await this.deps.sessionService.getSession({
      appName,
      userId: body.userId,
      sessionId: body.sessionId,
    });
    if (!session) {
      // adk-python asserts here, which surfaces as a 500. A request naming a
      // session that does not exist is a client error, so adk-js answers 400.
      this.fail(res, 400, `Session not found: ${body.sessionId}`);
      return;
    }

    const loaded = await this.deps.agentLoader.loadAgent(appName);
    const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
    const evalCase: EvalCase = {
      evalId: body.evalId,
      conversation: convertEventsToEvalInvocations(session.events),
      sessionInput: {
        appName,
        userId: body.userId,
        state: createEmptyState(rootAgent),
      },
      creationTimestamp: Date.now() / 1000,
    };

    await this.answer(
      res,
      async () => {
        await this.deps.evalSetsManager.addEvalCase(
          appName,
          evalSetId,
          evalCase,
        );
        return evalCase;
      },
      ADD_SESSION_STATUS_BY_ERROR_NAME,
    );
  }

  async listEvalsInEvalSet(req: Request, res: Response): Promise<void> {
    const evalSet = await this.getEvalSet(req);
    if (!evalSet) {
      // 400 rather than 404, matching adk-python.
      this.fail(res, 400, `Eval set \`${req.params['evalSetId']}\` not found.`);
      return;
    }
    res.json(evalSet.evalCases.map((evalCase) => evalCase.evalId).sort());
  }

  async getEval(req: Request, res: Response): Promise<void> {
    const evalCase = await this.deps.evalSetsManager.getEvalCase(
      req.params['appName'],
      req.params['evalSetId'],
      req.params['evalCaseId'],
    );
    if (!evalCase) {
      this.fail(res, 404, this.missingEvalCaseMessage(req));
      return;
    }
    res.json(evalCase);
  }

  async updateEval(req: Request, res: Response): Promise<void> {
    const evalCaseId = req.params['evalCaseId'];
    const body = req.body as EvalCase;
    if (body.evalId && body.evalId !== evalCaseId) {
      this.fail(
        res,
        400,
        'Eval id in EvalCase should match the eval id in the API route.',
      );
      return;
    }

    // Overwrites the same value, or an empty field.
    const updatedEvalCase: EvalCase = {...body, evalId: evalCaseId};
    await this.answer(res, async () => {
      await this.deps.evalSetsManager.updateEvalCase(
        req.params['appName'],
        req.params['evalSetId'],
        updatedEvalCase,
      );
      return updatedEvalCase;
    });
  }

  async deleteEval(req: Request, res: Response): Promise<void> {
    await this.answer(res, () =>
      this.deps.evalSetsManager.deleteEvalCase(
        req.params['appName'],
        req.params['evalSetId'],
        req.params['evalCaseId'],
      ),
    );
  }

  async runEval(req: Request, res: Response): Promise<void> {
    const results = await this.collectRunEvalResults(req, res);
    if (results) {
      res.json({runEvalResults: results} satisfies RunEvalResponse);
    }
  }

  async runEvalLegacy(req: Request, res: Response): Promise<void> {
    const results = await this.collectRunEvalResults(req, res);
    if (results) {
      res.json(results);
    }
  }

  /**
   * Runs the eval set and returns its results, or answers the request and
   * returns undefined when it cannot be run.
   */
  private async collectRunEvalResults(
    req: Request,
    res: Response,
  ): Promise<RunEvalResult[] | undefined> {
    const appName = req.params['appName'];
    const evalSetId = req.params['evalSetId'];
    const body = (req.body ?? {}) as RunEvalRequest;

    const evalSet = await this.getEvalSet(req);
    if (!evalSet) {
      this.fail(res, 400, `Eval set \`${evalSetId}\` not found.`);
      return undefined;
    }

    try {
      const evalCaseResults = await this.scoreEvalSet(appName, evalSet, body);
      return evalCaseResults.map((result) =>
        toRunEvalResult(result, evalSetId),
      );
    } catch (error: unknown) {
      const message = errorMessage(error);
      // `getEvalRuntime` reports exactly this when nothing installed a
      // runtime, which is adk-js's equivalent of adk-python's
      // ModuleNotFoundError on `local_eval_service`. Every other failure is a
      // 500, as it is there.
      const status = message === MISSING_EVAL_DEPENDENCIES_MESSAGE ? 400 : 500;
      this.fail(res, status, message);
      return undefined;
    }
  }

  /** Drives the eval runtime over one eval set and collects every result. */
  private async scoreEvalSet(
    appName: string,
    evalSet: EvalSet,
    request: RunEvalRequest,
  ): Promise<EvalCaseResult[]> {
    const loaded = await this.deps.agentLoader.loadAgent(appName);
    const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
    if (!isBaseAgent(rootAgent)) {
      throw new Error(
        `App \`${appName}\` is rooted in a workflow, which the eval ` +
          `service cannot score.`,
      );
    }

    const evalService = getEvalRuntime().createEvalService({
      rootAgent,
      app: isApp(loaded) ? loaded : undefined,
      evalSetsManager: this.deps.evalSetsManager,
      evalConfig: {criteria: criteriaFrom(request.evalMetrics)},
      metricEvaluatorRegistry: defaultMetricEvaluatorRegistry().fork(),
      artifactService: this.deps.artifactService,
      evalSetResultsManager: this.deps.evalSetResultsManager,
    });

    const inferenceResults: InferenceResult[] = [];
    for await (const inference of evalService.performInference({
      appName,
      evalSetId: evalSet.evalSetId,
      evalCaseIds: request.evalIds,
      inferenceConfig: {useLive: false},
    })) {
      inferenceResults.push(inference);
    }

    const evalCaseResults: EvalCaseResult[] = [];
    for await (const result of evalService.evaluate({
      inferenceResults,
      evaluateConfig: {evalMetrics: request.evalMetrics ?? []},
    })) {
      evalCaseResults.push(result);
    }
    return evalCaseResults;
  }

  async getEvalResult(req: Request, res: Response): Promise<void> {
    await this.answer(res, () =>
      this.deps.evalSetResultsManager.getEvalSetResult(
        req.params['appName'],
        req.params['evalResultId'],
      ),
    );
  }

  async listEvalResults(req: Request, res: Response): Promise<void> {
    const evalResultIds =
      await this.deps.evalSetResultsManager.listEvalSetResults(
        req.params['appName'],
      );
    res.json({evalResultIds} satisfies ListEvalResultsResponse);
  }

  async listEvalResultsLegacy(req: Request, res: Response): Promise<void> {
    res.json(
      await this.deps.evalSetResultsManager.listEvalSetResults(
        req.params['appName'],
      ),
    );
  }

  /**
   * adk-python answers 400 here when importing its registry raises
   * ModuleNotFoundError. adk-js has no such import to fail: the registry is
   * part of `@google/adk` and always seeds its standard metrics, so there is
   * no empty case to report.
   */
  listMetricsInfo(req: Request, res: Response): void {
    // The metrics do not depend on the app, as in adk-python, which ignores
    // its `app_name` here too.
    res.json({
      metricsInfo: defaultMetricEvaluatorRegistry().getRegisteredMetrics(),
    } satisfies ListMetricsInfoResponse);
  }

  private getEvalSet(req: Request): Promise<EvalSet | undefined> {
    return this.deps.evalSetsManager.getEvalSet(
      req.params['appName'],
      req.params['evalSetId'],
    );
  }

  private missingEvalCaseMessage(req: Request): string {
    return (
      `Eval set \`${req.params['evalSetId']}\` or Eval ` +
      `\`${req.params['evalCaseId']}\` not found.`
    );
  }

  /**
   * Runs a manager call and answers with whatever it returned, mapping the
   * error classes the managers raise to the statuses adk-python answers with.
   * A failure this does not recognise is a 500, as everywhere else in the
   * server.
   */
  private async answer(
    res: Response,
    body: () => Promise<EvalSet | EvalCase | EvalSetResult | void>,
    statusByErrorName: Record<string, number> = STATUS_BY_ERROR_NAME,
  ): Promise<void> {
    try {
      res.json((await body()) ?? {});
    } catch (error: unknown) {
      const status = statusByErrorName[errorName(error) ?? ''] ?? 500;
      this.fail(res, status, errorMessage(error));
    }
  }

  private fail(res: Response, status: number, error: string): void {
    res.status(status).json({error});
    this.deps.logger.error(error);
  }
}

/**
 * Turns the requested metrics into the `criteria` map an eval config carries.
 * The eval service reads the metrics from the evaluate request; the config
 * carries them too, so a custom metric resolves by name.
 */
function criteriaFrom(evalMetrics?: EvalMetric[]): EvalConfig['criteria'] {
  const criteria: EvalConfig['criteria'] = {};
  for (const metric of evalMetrics ?? []) {
    if (metric.criterion !== undefined) {
      criteria[metric.metricName] = metric.criterion;
    }
  }
  return criteria;
}

/** Reshapes one eval case result into the payload the dev UI reads. */
function toRunEvalResult(
  result: EvalCaseResult,
  evalSetId: string,
): RunEvalResult {
  return {
    evalSetFile: result.evalSetFile,
    evalSetId,
    evalId: result.evalId,
    finalEvalStatus: result.finalEvalStatus,
    overallEvalMetricResults: result.overallEvalMetricResults,
    evalMetricResultPerInvocation: result.evalMetricResultPerInvocation,
    userId: result.userId,
    sessionId: result.sessionId,
  };
}
