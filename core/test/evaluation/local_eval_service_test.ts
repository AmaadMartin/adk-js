/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  EVAL_CLIENT_LABEL,
  EvalCase,
  EvalMetric,
  EvalStatus,
  EvaluationResult,
  Evaluator,
  getClientLabels,
  InferenceResult,
  InferenceStatus,
  InMemoryEvalSetsManager,
  InMemorySessionService,
  InputValidationError,
  Invocation,
  LlmAgent,
  LocalEvalService,
  MetricEvaluatorRegistry,
  NotFoundError,
  Rubric,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  generateInferencesFromRootAgent,
  generateInferencesFromRootAgentLive,
} from '../../src/evaluation/evaluation_generator.js';
import {
  createEvalSessionId,
  EVAL_SESSION_ID_PREFIX,
  generateFinalEvalStatus,
} from '../../src/evaluation/local_eval_service.js';
import {RecordingEvalSetResultsManager} from './stub_eval_service.js';
import {ScriptedLlm} from './test_helpers.js';

vi.mock(
  '../../src/evaluation/evaluation_generator.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../src/evaluation/evaluation_generator.js')
      >();
    return {
      ...actual,
      generateInferencesFromRootAgent: vi.fn(),
      generateInferencesFromRootAgentLive: vi.fn(),
    };
  },
);

const generateAsync = vi.mocked(generateInferencesFromRootAgent);
const generateLive = vi.mocked(generateInferencesFromRootAgentLive);

const APP_NAME = 'test_app';
const EVAL_SET_ID = 'test_eval_set';
const PAIRED_METRIC: EvalMetric = {metricName: 'paired_metric', threshold: 0.5};
const SINGLE_SIDED_METRIC: EvalMetric = {
  metricName: 'single_sided_metric',
  threshold: 0.5,
};
const FAILING_METRIC: EvalMetric = {
  metricName: 'failing_metric',
  threshold: 0.5,
};
const TRUNCATING_METRIC: EvalMetric = {
  metricName: 'truncating_metric',
  threshold: 0.5,
};
const FIXED_STATUS_METRIC: EvalMetric = {
  metricName: 'fixed_status_metric',
  threshold: 0.5,
};

/** A promise the test settles by hand. */
class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

/** Scores each actual invocation against its expected counterpart. */
class PairedEvaluator implements Evaluator {
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult {
    if (expectedInvocations === undefined) {
      throw new InputValidationError('This metric needs expectedInvocations.');
    }
    return {
      overallScore: 0.9,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: actualInvocations.map(
        (actualInvocation, index) => ({
          actualInvocation,
          expectedInvocation: expectedInvocations[index],
          score: 0.9,
          evalStatus: EvalStatus.PASSED,
        }),
      ),
    };
  }
}

/** Scores actual invocations on their own, ignoring the expected ones. */
class SingleSidedEvaluator implements Evaluator {
  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    return {
      overallScore: 0.95,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: actualInvocations.map((actualInvocation) => ({
        actualInvocation,
        score: 0.995,
        evalStatus: EvalStatus.PASSED,
      })),
    };
  }
}

/** An evaluator whose scoring raises. */
class FailingEvaluator implements Evaluator {
  evaluateInvocations(): EvaluationResult {
    throw new Error('the judge is unavailable');
  }
}

/** Returns fewer per-invocation results than there are invocations. */
class TruncatingEvaluator implements Evaluator {
  constructor(private readonly overallEvalStatus: EvalStatus) {}

  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    return {
      overallScore: 0.5,
      overallEvalStatus: this.overallEvalStatus,
      perInvocationResults: actualInvocations
        .slice(0, actualInvocations.length - 1)
        .map((actualInvocation) => ({
          actualInvocation,
          score: 0.5,
          evalStatus: this.overallEvalStatus,
        })),
    };
  }
}

/** Reports the status it was built with, for every invocation. */
class FixedStatusEvaluator implements Evaluator {
  constructor(private readonly evalStatus: EvalStatus) {}

  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    return {
      overallScore: 0.5,
      overallEvalStatus: this.evalStatus,
      perInvocationResults: actualInvocations.map((actualInvocation) => ({
        actualInvocation,
        score: 0.5,
        evalStatus: this.evalStatus,
      })),
    };
  }
}

function invocation(id: string, rubrics?: Rubric[]): Invocation {
  return {
    invocationId: id,
    userContent: {role: 'user', parts: [{text: `ask ${id}`}]},
    finalResponse: {role: 'model', parts: [{text: `reply ${id}`}]},
    rubrics,
  };
}

function rubric(rubricId: string): Rubric {
  return {rubricId, rubricContent: {textProperty: `property of ${rubricId}`}};
}

function buildEvalCase(
  evalId: string,
  turns = 1,
  extra: Partial<EvalCase> = {},
): EvalCase {
  return {
    evalId,
    conversation: Array.from({length: turns}, (unused, index) =>
      invocation(`${evalId}-turn-${index}`),
    ),
    creationTimestamp: 0,
    ...extra,
  };
}

async function managerWith(
  evalCases: EvalCase[],
  evalSetId = EVAL_SET_ID,
): Promise<InMemoryEvalSetsManager> {
  const manager = new InMemoryEvalSetsManager();
  await manager.createEvalSet(APP_NAME, evalSetId);
  for (const evalCase of evalCases) {
    await manager.addEvalCase(APP_NAME, evalSetId, evalCase);
  }
  return manager;
}

function buildRegistry(): MetricEvaluatorRegistry {
  const registry = new MetricEvaluatorRegistry();
  registry.registerEvaluator(
    PAIRED_METRIC.metricName,
    () => new PairedEvaluator(),
  );
  registry.registerEvaluator(
    SINGLE_SIDED_METRIC.metricName,
    () => new SingleSidedEvaluator(),
  );
  registry.registerEvaluator(
    FAILING_METRIC.metricName,
    () => new FailingEvaluator(),
  );
  return registry;
}

function buildService(
  options: Partial<ConstructorParameters<typeof LocalEvalService>[0]> & {
    evalSetsManager: InMemoryEvalSetsManager;
  },
): LocalEvalService {
  return new LocalEvalService({
    rootAgent: new LlmAgent({
      name: 'test_agent',
      model: new ScriptedLlm(['ok']),
    }),
    metricEvaluatorRegistry: buildRegistry(),
    ...options,
  });
}

function inferenceResult(
  evalCaseId: string,
  overrides: Partial<InferenceResult> = {},
): InferenceResult {
  return {
    appName: APP_NAME,
    evalSetId: EVAL_SET_ID,
    evalCaseId,
    sessionId: `session-${evalCaseId}`,
    status: InferenceStatus.SUCCESS,
    inferences: [invocation(`${evalCaseId}-turn-0`)],
    ...overrides,
  };
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) {
    collected.push(item);
  }
  return collected;
}

beforeEach(() => {
  vi.clearAllMocks();
  generateAsync.mockResolvedValue([invocation('generated')]);
  generateLive.mockResolvedValue([invocation('generated-live')]);
});

describe('LocalEvalService.performInference', () => {
  it('runs every eval case of the requested eval set', async () => {
    const evalSetsManager = await managerWith([
      buildEvalCase('case1'),
      buildEvalCase('case2'),
    ]);
    const getEvalSet = vi.spyOn(evalSetsManager, 'getEvalSet');

    const results = await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false, parallelism: 2},
      }),
    );

    expect(getEvalSet).toHaveBeenCalledExactlyOnceWith(APP_NAME, EVAL_SET_ID);
    expect(results.map((result) => result.evalCaseId).sort()).toEqual([
      'case1',
      'case2',
    ]);
    expect(
      results.every((result) => result.status === InferenceStatus.SUCCESS),
    ).toBe(true);
  });

  it('runs only the eval cases the request names', async () => {
    const evalSetsManager = await managerWith([
      buildEvalCase('case1'),
      buildEvalCase('case2'),
      buildEvalCase('case3'),
    ]);

    const results = await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        evalCaseIds: ['case1', 'case3'],
        inferenceConfig: {useLive: false},
      }),
    );

    expect(results.map((result) => result.evalCaseId).sort()).toEqual([
      'case1',
      'case3',
    ]);
    expect(generateAsync).toHaveBeenCalledTimes(2);
  });

  it('reads an empty evalCaseIds as unspecified and runs the whole set', async () => {
    const evalSetsManager = await managerWith([
      buildEvalCase('case1'),
      buildEvalCase('case2'),
    ]);

    const results = await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        evalCaseIds: [],
        inferenceConfig: {useLive: false},
      }),
    );

    expect(results.map((result) => result.evalCaseId).sort()).toEqual([
      'case1',
      'case2',
    ]);
  });

  it('routes a live run to the live generator with its timeout', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);

    await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: true, liveTimeoutSeconds: 600},
      }),
    );

    expect(generateAsync).not.toHaveBeenCalled();
    expect(generateLive).toHaveBeenCalledTimes(1);
    expect(generateLive.mock.calls[0][0].liveTimeoutSeconds).toBe(600);
  });

  it('routes a non-live run to the async generator with no timeout', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);

    await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false},
      }),
    );

    expect(generateLive).not.toHaveBeenCalled();
    expect(generateAsync.mock.calls[0][0]).not.toHaveProperty(
      'liveTimeoutSeconds',
    );
  });

  it('reports an unknown eval set as not found', async () => {
    const evalSetsManager = await managerWith([]);

    await expect(
      collect(
        buildService({evalSetsManager}).performInference({
          appName: APP_NAME,
          evalSetId: 'missing_set',
          inferenceConfig: {useLive: false},
        }),
      ),
    ).rejects.toThrow(
      new NotFoundError(
        `Eval set with id missing_set not found for app ${APP_NAME}`,
      ),
    );
  });

  it('forwards the app to both generators, and undefined without one', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);
    const app = new App({
      name: APP_NAME,
      rootAgent: new LlmAgent({
        name: 'app_agent',
        model: new ScriptedLlm(['ok']),
      }),
    });

    for (const useLive of [false, true]) {
      await collect(
        buildService({evalSetsManager, app}).performInference({
          appName: APP_NAME,
          evalSetId: EVAL_SET_ID,
          inferenceConfig: {useLive},
        }),
      );
      await collect(
        buildService({evalSetsManager}).performInference({
          appName: APP_NAME,
          evalSetId: EVAL_SET_ID,
          inferenceConfig: {useLive},
        }),
      );
    }

    expect(generateAsync.mock.calls.map((call) => call[0].app)).toEqual([
      app,
      undefined,
    ]);
    expect(generateLive.mock.calls.map((call) => call[0].app)).toEqual([
      app,
      undefined,
    ]);
  });

  it('keeps a pinned session id across repeated runs', async () => {
    const evalSetsManager = await managerWith([
      buildEvalCase('case1', 1, {
        sessionInput: {
          appName: APP_NAME,
          userId: 'pinned_user',
          sessionId: 'pinned_session',
        },
      }),
    ]);
    const sessionIdSupplier = vi.fn(() => 'generated_session');
    const service = buildService({evalSetsManager, sessionIdSupplier});
    const request = {
      appName: APP_NAME,
      evalSetId: EVAL_SET_ID,
      inferenceConfig: {useLive: false},
    };

    const first = await collect(service.performInference(request));
    const second = await collect(service.performInference(request));

    expect(sessionIdSupplier).not.toHaveBeenCalled();
    expect(first[0].sessionId).toBe('pinned_session');
    expect(second[0].sessionId).toBe('pinned_session');
    expect(generateAsync.mock.calls[0][0].sessionId).toBeUndefined();
    expect(generateAsync.mock.calls[1][0].sessionId).toBeUndefined();
  });

  it('generates a session id when the eval case pins none', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);

    const results = await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false},
      }),
    );

    expect(results[0].sessionId).toMatch(
      new RegExp(`^${EVAL_SESSION_ID_PREFIX}`),
    );
    expect(generateAsync.mock.calls[0][0].sessionId).toBe(results[0].sessionId);
  });

  it('reports a failing run as a failure without stopping the batch', async () => {
    const evalSetsManager = await managerWith([
      buildEvalCase('case1'),
      buildEvalCase('case2'),
    ]);
    generateAsync.mockImplementation(async (params) =>
      params.initialSession?.userId === 'doomed'
        ? Promise.reject(new Error('the model refused'))
        : [invocation('generated')],
    );
    const doomed = buildEvalCase('case1', 1, {
      sessionInput: {appName: APP_NAME, userId: 'doomed'},
    });
    await evalSetsManager.updateEvalCase(APP_NAME, EVAL_SET_ID, doomed);

    const results = await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false},
      }),
    );

    const failed = results.find((result) => result.evalCaseId === 'case1');
    const succeeded = results.find((result) => result.evalCaseId === 'case2');
    expect(failed?.status).toBe(InferenceStatus.FAILURE);
    expect(failed?.errorMessage).toContain('the model refused');
    expect(failed?.inferences).toBeUndefined();
    expect(succeeded?.status).toBe(InferenceStatus.SUCCESS);
  });

  it('reports a case with no conversation as a failure', async () => {
    const evalSetsManager = await managerWith([
      {evalId: 'case1', creationTimestamp: 0},
    ]);

    const results = await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false},
      }),
    );

    expect(results[0].status).toBe(InferenceStatus.FAILURE);
    expect(results[0].errorMessage).toContain(
      'Neither static invocations nor conversation scenario provided',
    );
    expect(generateAsync).not.toHaveBeenCalled();
  });

  it('never runs more inferences at a time than parallelism allows', async () => {
    const evalSetsManager = await managerWith(
      ['case1', 'case2', 'case3', 'case4'].map((evalId) =>
        buildEvalCase(evalId),
      ),
    );
    const gates: Array<Deferred<Invocation[]>> = [];
    let inFlight = 0;
    let peak = 0;
    generateAsync.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const gate = new Deferred<Invocation[]>();
      gates.push(gate);
      const inferences = await gate.promise;
      inFlight--;
      return inferences;
    });

    const results = collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false, parallelism: 2},
      }),
    );
    for (let released = 0; released < 4; released++) {
      await vi.waitUntil(() => gates.length > released);
      gates[released].resolve([invocation('generated')]);
    }

    expect(await results).toHaveLength(4);
    expect(peak).toBe(2);
  });

  it('labels the model calls an inference makes as eval traffic', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);
    let labels: string[] = [];
    generateAsync.mockImplementation(async () => {
      labels = getClientLabels();
      return [invocation('generated')];
    });

    await collect(
      buildService({evalSetsManager}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false},
      }),
    );

    expect(labels).toContain(EVAL_CLIENT_LABEL);
  });
});

describe('LocalEvalService.evaluate', () => {
  it('saves one result group per eval set', async () => {
    const evalSetsManager = await managerWith([
      buildEvalCase('case1'),
      buildEvalCase('case2'),
    ]);
    const evalSetResultsManager = new RecordingEvalSetResultsManager();

    const results = await collect(
      buildService({evalSetsManager, evalSetResultsManager}).evaluate({
        inferenceResults: [inferenceResult('case1'), inferenceResult('case2')],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    expect(results).toHaveLength(2);
    expect(evalSetResultsManager.saved).toHaveLength(1);
    expect(evalSetResultsManager.saved[0].appName).toBe(APP_NAME);
    expect(evalSetResultsManager.saved[0].evalSetId).toBe(EVAL_SET_ID);
    expect(evalSetResultsManager.saved[0].evalCaseResults).toHaveLength(2);
  });

  it('saves each eval set separately', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);
    await evalSetsManager.createEvalSet(APP_NAME, 'other_set');
    await evalSetsManager.addEvalCase(
      APP_NAME,
      'other_set',
      buildEvalCase('case2'),
    );
    const evalSetResultsManager = new RecordingEvalSetResultsManager();

    await collect(
      buildService({evalSetsManager, evalSetResultsManager}).evaluate({
        inferenceResults: [
          inferenceResult('case1'),
          inferenceResult('case2', {evalSetId: 'other_set'}),
        ],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    expect(
      evalSetResultsManager.saved.map((entry) => entry.evalSetId).sort(),
    ).toEqual(['other_set', EVAL_SET_ID]);
  });

  it('yields results without saving when no results manager is configured', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);

    const results = await collect(
      buildService({evalSetsManager}).evaluate({
        inferenceResults: [inferenceResult('case1')],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].finalEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('reports an unknown eval case as not found before any metric runs', async () => {
    const evalSetsManager = await managerWith([]);
    const registry = buildRegistry();
    const getEvaluator = vi.spyOn(registry, 'getEvaluator');

    await expect(
      collect(
        buildService({
          evalSetsManager,
          metricEvaluatorRegistry: registry,
        }).evaluate({
          inferenceResults: [inferenceResult('ghost_case')],
          evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
        }),
      ),
    ).rejects.toThrow(
      new NotFoundError(
        `Eval case with id ghost_case not found for app ${APP_NAME} and ` +
          `eval set ${EVAL_SET_ID}.`,
      ),
    );
    expect(getEvaluator).not.toHaveBeenCalled();
  });

  it('reports an unknown eval case even when the inference produced nothing', async () => {
    const evalSetsManager = await managerWith([]);

    await expect(
      collect(
        buildService({evalSetsManager}).evaluate({
          inferenceResults: [
            inferenceResult('ghost_case', {
              inferences: undefined,
              status: InferenceStatus.FAILURE,
            }),
          ],
          evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
        }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('scores every invocation and pairs it with its expected counterpart', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1', 3)]);
    const expected = buildEvalCase('case1', 3).conversation ?? [];
    const actual = [0, 1, 2].map((index) => invocation(`actual-${index}`));

    const results = await collect(
      buildService({evalSetsManager}).evaluate({
        inferenceResults: [inferenceResult('case1', {inferences: actual})],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    const [result] = results;
    expect(result.overallEvalMetricResults).toEqual([
      {...PAIRED_METRIC, score: 0.9, evalStatus: EvalStatus.PASSED},
    ]);
    expect(result.evalMetricResultPerInvocation).toHaveLength(3);
    result.evalMetricResultPerInvocation.forEach((perInvocation, index) => {
      expect(perInvocation.actualInvocation).toBe(actual[index]);
      expect(perInvocation.expectedInvocation?.invocationId).toBe(
        expected[index].invocationId,
      );
      expect(perInvocation.evalMetricResults).toEqual([
        {...PAIRED_METRIC, score: 0.9, evalStatus: EvalStatus.PASSED},
      ]);
    });
    expect(result.finalEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails a case whose inference produced nothing, and still loads its session', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: 'test_user_id',
      sessionId: 'session-case1',
    });

    const results = await collect(
      buildService({evalSetsManager, sessionService}).evaluate({
        inferenceResults: [
          inferenceResult('case1', {
            inferences: undefined,
            status: InferenceStatus.FAILURE,
          }),
        ],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    expect(results[0].finalEvalStatus).toBe(EvalStatus.FAILED);
    expect(results[0].overallEvalMetricResults).toEqual([]);
    expect(results[0].evalMetricResultPerInvocation).toEqual([]);
    expect(results[0].sessionId).toBe('session-case1');
    expect(results[0].sessionDetails?.id).toBe(session.id);
  });

  it('reports an empty session id for a failure that never opened one', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);

    const results = await collect(
      buildService({evalSetsManager}).evaluate({
        inferenceResults: [
          inferenceResult('case1', {
            inferences: undefined,
            sessionId: undefined,
            status: InferenceStatus.FAILURE,
          }),
        ],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    expect(results[0].finalEvalStatus).toBe(EvalStatus.FAILED);
    expect(results[0].sessionId).toBe('');
    expect(results[0].sessionDetails).toBeUndefined();
  });

  it('rejects an eval case that carries no conversation', async () => {
    const evalSetsManager = await managerWith([
      {evalId: 'case1', creationTimestamp: 0},
    ]);

    await expect(
      collect(
        buildService({evalSetsManager}).evaluate({
          inferenceResults: [inferenceResult('case1')],
          evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
        }),
      ),
    ).rejects.toThrow(
      new InputValidationError(
        'A static eval case must provide an expected conversation.',
      ),
    );
  });

  it('rejects inferences that do not line up with the conversation', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1', 2)]);

    await expect(
      collect(
        buildService({evalSetsManager}).evaluate({
          inferenceResults: [
            inferenceResult('case1', {
              inferences: [0, 1, 2].map((index) =>
                invocation(`actual-${index}`),
              ),
            }),
          ],
          evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
        }),
      ),
    ).rejects.toThrow(
      new InputValidationError(
        'Inferences should match conversations in eval case. Found 3 ' +
          'inferences and 2 conversations in eval case.',
      ),
    );
  });

  it('degrades a failing metric and still scores the others', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1', 2)]);
    const actual = [0, 1].map((index) => invocation(`actual-${index}`));

    const results = await collect(
      buildService({evalSetsManager}).evaluate({
        inferenceResults: [inferenceResult('case1', {inferences: actual})],
        evaluateConfig: {evalMetrics: [FAILING_METRIC, SINGLE_SIDED_METRIC]},
      }),
    );

    const [result] = results;
    expect(result.overallEvalMetricResults).toEqual([
      {
        ...FAILING_METRIC,
        score: undefined,
        evalStatus: EvalStatus.NOT_EVALUATED,
      },
      {
        ...SINGLE_SIDED_METRIC,
        score: 0.95,
        evalStatus: EvalStatus.PASSED,
      },
    ]);
    expect(result.evalMetricResultPerInvocation).toHaveLength(2);
    for (const perInvocation of result.evalMetricResultPerInvocation) {
      expect(perInvocation.evalMetricResults).toEqual([
        {
          ...FAILING_METRIC,
          score: undefined,
          evalStatus: EvalStatus.NOT_EVALUATED,
        },
        {
          ...SINGLE_SIDED_METRIC,
          score: 0.995,
          evalStatus: EvalStatus.PASSED,
        },
      ]);
    }
    expect(result.finalEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('rejects an evaluated metric that scored the wrong number of invocations', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1', 3)]);
    const registry = buildRegistry();
    registry.registerEvaluator(
      TRUNCATING_METRIC.metricName,
      () => new TruncatingEvaluator(EvalStatus.PASSED),
    );

    await expect(
      collect(
        buildService({
          evalSetsManager,
          metricEvaluatorRegistry: registry,
        }).evaluate({
          inferenceResults: [
            inferenceResult('case1', {
              inferences: [0, 1, 2].map((index) =>
                invocation(`actual-${index}`),
              ),
            }),
          ],
          evaluateConfig: {evalMetrics: [TRUNCATING_METRIC]},
        }),
      ),
    ).rejects.toThrow(
      new InputValidationError(
        'Eval metric should return results for each invocation. Found 2 ' +
          'results for 3 invocations.',
      ),
    );
  });

  it('tolerates a short result list from a metric that evaluated nothing', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1', 3)]);
    const registry = buildRegistry();
    registry.registerEvaluator(
      TRUNCATING_METRIC.metricName,
      () => new TruncatingEvaluator(EvalStatus.NOT_EVALUATED),
    );

    const results = await collect(
      buildService({
        evalSetsManager,
        metricEvaluatorRegistry: registry,
      }).evaluate({
        inferenceResults: [
          inferenceResult('case1', {
            inferences: [0, 1, 2].map((index) => invocation(`actual-${index}`)),
          }),
        ],
        evaluateConfig: {evalMetrics: [TRUNCATING_METRIC]},
      }),
    );

    expect(results[0].finalEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(results[0].evalMetricResultPerInvocation).toHaveLength(3);
    expect(
      results[0].evalMetricResultPerInvocation[2].evalMetricResults[0],
    ).toEqual({
      ...TRUNCATING_METRIC,
      score: undefined,
      evalStatus: EvalStatus.NOT_EVALUATED,
    });
  });

  it('takes the user id from the session input', async () => {
    const evalSetsManager = await managerWith([
      buildEvalCase('case1', 1, {
        sessionInput: {appName: APP_NAME, userId: 'alice'},
      }),
    ]);

    const results = await collect(
      buildService({evalSetsManager}).evaluate({
        inferenceResults: [inferenceResult('case1')],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    expect(results[0].userId).toBe('alice');
  });

  it('falls back to the default user id and an empty session id', async () => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);

    const results = await collect(
      buildService({evalSetsManager}).evaluate({
        inferenceResults: [inferenceResult('case1', {sessionId: undefined})],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    expect(results[0].userId).toBe('test_user_id');
    expect(results[0].sessionId).toBe('');
    expect(results[0].sessionDetails).toBeUndefined();
  });

  it.each([
    {
      name: 'passes when every metric passed',
      statuses: [EvalStatus.PASSED, EvalStatus.PASSED],
      expected: EvalStatus.PASSED,
    },
    {
      name: 'fails when one metric failed',
      statuses: [EvalStatus.PASSED, EvalStatus.FAILED],
      expected: EvalStatus.FAILED,
    },
    {
      name: 'stays unevaluated when no metric was evaluated',
      statuses: [EvalStatus.NOT_EVALUATED, EvalStatus.NOT_EVALUATED],
      expected: EvalStatus.NOT_EVALUATED,
    },
  ])('$name', async ({statuses, expected}) => {
    const evalSetsManager = await managerWith([buildEvalCase('case1')]);
    const registry = buildRegistry();
    const evalMetrics = statuses.map((status, index) => {
      const metricName = `${FIXED_STATUS_METRIC.metricName}_${index}`;
      registry.registerEvaluator(
        metricName,
        () => new FixedStatusEvaluator(status),
      );
      return {...FIXED_STATUS_METRIC, metricName};
    });

    const results = await collect(
      buildService({
        evalSetsManager,
        metricEvaluatorRegistry: registry,
      }).evaluate({
        inferenceResults: [inferenceResult('case1')],
        evaluateConfig: {evalMetrics},
      }),
    );

    expect(results[0].finalEvalStatus).toBe(expected);
  });

  it('never runs more evaluations at a time than parallelism allows', async () => {
    const evalSetsManager = await managerWith(
      ['case1', 'case2', 'case3', 'case4'].map((evalId) =>
        buildEvalCase(evalId),
      ),
    );
    const gates: Array<Deferred<void>> = [];
    let inFlight = 0;
    let peak = 0;
    const registry = buildRegistry();
    registry.registerEvaluator(SINGLE_SIDED_METRIC.metricName, () => ({
      async evaluateInvocations(actualInvocations: Invocation[]) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        const gate = new Deferred<void>();
        gates.push(gate);
        await gate.promise;
        inFlight--;
        return new SingleSidedEvaluator().evaluateInvocations(
          actualInvocations,
        );
      },
    }));

    const results = collect(
      buildService({
        evalSetsManager,
        metricEvaluatorRegistry: registry,
      }).evaluate({
        inferenceResults: ['case1', 'case2', 'case3', 'case4'].map((evalId) =>
          inferenceResult(evalId),
        ),
        evaluateConfig: {evalMetrics: [SINGLE_SIDED_METRIC], parallelism: 2},
      }),
    );
    for (let released = 0; released < 4; released++) {
      await vi.waitUntil(() => gates.length > released);
      gates[released].resolve();
    }

    expect(await results).toHaveLength(4);
    expect(peak).toBe(2);
  });

  it('reports a rubric id shared by the eval case and an invocation', async () => {
    const evalSetsManager = await managerWith([
      {
        evalId: 'case1',
        creationTimestamp: 0,
        rubrics: [rubric('shared')],
        conversation: [invocation('expected-0', [rubric('shared')])],
      },
    ]);

    await expect(
      collect(
        buildService({evalSetsManager}).evaluate({
          inferenceResults: [inferenceResult('case1')],
          evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
        }),
      ),
    ).rejects.toThrow(
      new InputValidationError(
        "Rubric with rubric_id 'shared' already exists.",
      ),
    );
  });

  it('carries eval case and invocation rubrics onto the scored invocations', async () => {
    const evalSetsManager = await managerWith([
      {
        evalId: 'case1',
        creationTimestamp: 0,
        rubrics: [rubric('case_level')],
        conversation: [invocation('expected-0', [rubric('turn_level')])],
      },
    ]);
    const actual = [invocation('actual-0')];

    await collect(
      buildService({evalSetsManager}).evaluate({
        inferenceResults: [inferenceResult('case1', {inferences: actual})],
        evaluateConfig: {evalMetrics: [PAIRED_METRIC]},
      }),
    );

    expect(actual[0].rubrics?.map((entry) => entry.rubricId)).toEqual([
      'case_level',
      'turn_level',
    ]);
  });
});

describe('createEvalSessionId', () => {
  it('prefixes a unique id so an eval session is recognizable', () => {
    const first = createEvalSessionId();
    const second = createEvalSessionId();

    expect(first.startsWith(EVAL_SESSION_ID_PREFIX)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe('generateFinalEvalStatus', () => {
  it('accepts every declared eval status', () => {
    for (const evalStatus of Object.values(EvalStatus).filter(
      (value): value is EvalStatus => typeof value === 'number',
    )) {
      expect(() =>
        generateFinalEvalStatus([{...PAIRED_METRIC, evalStatus}]),
      ).not.toThrow();
    }
  });

  it('rejects a status the fold does not know', () => {
    const unknownStatus = 99 as EvalStatus;

    expect(() =>
      generateFinalEvalStatus([{...PAIRED_METRIC, evalStatus: unknownStatus}]),
    ).toThrow(new InputValidationError('Unknown eval status: 99.'));
  });

  it('stops at the first failure', () => {
    expect(
      generateFinalEvalStatus([
        {...PAIRED_METRIC, evalStatus: EvalStatus.FAILED},
        {...PAIRED_METRIC, evalStatus: EvalStatus.PASSED},
      ]),
    ).toBe(EvalStatus.FAILED);
  });

  it('reports an empty metric list as unevaluated', () => {
    expect(generateFinalEvalStatus([])).toBe(EvalStatus.NOT_EVALUATED);
  });
});
