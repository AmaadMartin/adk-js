/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  ConversationScenario,
  DEFAULT_METRIC_EVALUATOR_REGISTRY,
  EvalCase,
  EvalCaseResult,
  EvalMetricResult,
  EvalSet,
  EvalSetResultsManager,
  EvalSetsManager,
  EvalStatus,
  EvaluateConfig,
  EvaluationGenerator,
  EvaluationResult,
  Evaluator,
  EvaluatorConstructorOptions,
  InferenceResult,
  InferenceStatus,
  Invocation,
  LocalEvalService,
  LocalEvalServiceOptions,
  MetricInfo,
  NotFoundError,
  Rubric,
  UserSimulator,
  UserSimulatorProvider,
  addRubricsToInvocation,
  copyEvalCaseRubricsToActualInvocations,
  copyInvocationRubricsToActualInvocations,
  generateFinalEvalStatus,
  getSessionId,
} from '@google/adk';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

// --- Fake evaluators, mirroring the adk-python reference test doubles. ---

const FAKE_METRIC_INFO: MetricInfo = {
  metricName: 'fake_metric',
  description: 'Fake metric description',
  metricValueInfo: {
    interval: {
      minValue: 0.0,
      openAtMin: false,
      maxValue: 1.0,
      openAtMax: false,
    },
  },
};

const FAKE_SINGLE_SIDED_METRIC_INFO: MetricInfo = {
  metricName: 'fake_single_sided_metric',
  description: 'Fake single sided metric description',
  metricValueInfo: {
    interval: {
      minValue: 0.0,
      openAtMin: false,
      maxValue: 1.0,
      openAtMax: false,
    },
  },
};

class FakeEvaluator extends Evaluator {
  constructor(_options: EvaluatorConstructorOptions) {
    super();
  }

  override evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult {
    if (expectedInvocations === undefined) {
      throw new Error('expected_invocations is required for this metric.');
    }
    const perInvocationResults = actualInvocations.map((actual, idx) => ({
      actualInvocation: actual,
      expectedInvocation: expectedInvocations[idx],
      score: 0.9,
      evalStatus: EvalStatus.PASSED,
    }));
    return {
      overallScore: 0.9,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults,
    };
  }
}

class FakeSingleSidedEvaluator extends Evaluator {
  constructor(_options: EvaluatorConstructorOptions) {
    super();
  }

  override evaluateInvocations(
    actualInvocations: Invocation[],
  ): EvaluationResult {
    const perInvocationResults = actualInvocations.map((actual) => ({
      actualInvocation: actual,
      score: 0.995,
      evalStatus: EvalStatus.PASSED,
    }));
    return {
      overallScore: 0.95,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults,
    };
  }
}

const FAKE_MISMATCH_METRIC_INFO: MetricInfo = {
  metricName: 'fake_mismatch_metric',
  description: 'Returns a mismatched number of per-invocation results',
  metricValueInfo: {
    interval: {
      minValue: 0.0,
      openAtMin: false,
      maxValue: 1.0,
      openAtMax: false,
    },
  },
};

// Returns a non-NOT_EVALUATED status but an empty per-invocation list, which
// must trigger the count-mismatch guard.
class FakeMismatchEvaluator extends Evaluator {
  constructor(_options: EvaluatorConstructorOptions) {
    super();
  }

  override evaluateInvocations(): EvaluationResult {
    return {
      overallScore: 0.5,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: [],
    };
  }
}

// --- Test helpers. ---

interface LocalEvalServicePrivates {
  evaluateSingleInferenceResult(
    inferenceResult: InferenceResult,
    evaluateConfig: EvaluateConfig,
  ): Promise<[InferenceResult, EvalCaseResult]>;
  performInferenceSingleEvalItem(params: {
    appName: string;
    evalSetId: string;
    evalCase: EvalCase;
  }): Promise<InferenceResult>;
}

function makeService(options: Partial<LocalEvalServiceOptions> = {}): {
  service: LocalEvalService;
  privates: LocalEvalServicePrivates;
  evalSetsManager: EvalSetsManager;
  evalSetResultsManager: EvalSetResultsManager;
  rootAgent: BaseAgent;
} {
  const evalSetsManager = {
    getEvalSet: vi.fn(),
    getEvalCase: vi.fn(),
  } as unknown as EvalSetsManager;
  const evalSetResultsManager = {
    saveEvalSetResult: vi.fn(),
  } as unknown as EvalSetResultsManager;
  const rootAgent = {name: 'test_agent'} as unknown as BaseAgent;
  const service = new LocalEvalService({
    rootAgent,
    evalSetsManager,
    evalSetResultsManager,
    ...options,
  });
  return {
    service,
    privates: service as unknown as LocalEvalServicePrivates,
    evalSetsManager,
    evalSetResultsManager,
    rootAgent,
  };
}

function makeInvocation(userText: string, finalText?: string): Invocation {
  return {
    invocationId: '',
    userContent: {parts: [{text: userText}]},
    finalResponse:
      finalText !== undefined ? {parts: [{text: finalText}]} : undefined,
    creationTimestamp: 0,
  };
}

function makeEvalCase(fields: Partial<EvalCase>): EvalCase {
  return {evalId: 'case1', ...fields} as unknown as EvalCase;
}

function makeInferenceResult(
  fields: Partial<InferenceResult> & {evalCaseId: string},
): InferenceResult {
  return {
    appName: 'test_app',
    evalSetId: 'test_eval_set',
    sessionId: 'session1',
    status: InferenceStatus.UNKNOWN,
    ...fields,
  } as InferenceResult;
}

beforeAll(() => {
  DEFAULT_METRIC_EVALUATOR_REGISTRY.registerEvaluator(
    FAKE_METRIC_INFO,
    FakeEvaluator,
  );
  DEFAULT_METRIC_EVALUATOR_REGISTRY.registerEvaluator(
    FAKE_SINGLE_SIDED_METRIC_INFO,
    FakeSingleSidedEvaluator,
  );
  DEFAULT_METRIC_EVALUATOR_REGISTRY.registerEvaluator(
    FAKE_MISMATCH_METRIC_INFO,
    FakeMismatchEvaluator,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LocalEvalService.performInference', () => {
  it('streams one result per eval case', async () => {
    const {service, privates, evalSetsManager} = makeService();
    const evalSet = {
      evalSetId: 'test_eval_set',
      evalCases: [
        makeEvalCase({evalId: 'case1', conversation: []}),
        makeEvalCase({evalId: 'case2', conversation: []}),
      ],
    } as unknown as EvalSet;
    vi.mocked(evalSetsManager.getEvalSet).mockResolvedValue(evalSet);

    const mockResult = makeInferenceResult({evalCaseId: 'case1'});
    const spy = vi
      .spyOn(privates, 'performInferenceSingleEvalItem')
      .mockResolvedValue(mockResult);

    const results: InferenceResult[] = [];
    for await (const result of service.performInference({
      appName: 'test_app',
      evalSetId: 'test_eval_set',
      inferenceConfig: {
        parallelism: 2,
        useLive: false,
        liveTimeoutSeconds: 300,
      },
    })) {
      results.push(result);
    }

    expect(results).toHaveLength(2);
    expect(results[0]).toBe(mockResult);
    expect(evalSetsManager.getEvalSet).toHaveBeenCalledWith(
      'test_app',
      'test_eval_set',
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('filters eval cases by evalCaseIds', async () => {
    const {service, privates, evalSetsManager} = makeService();
    const evalSet = {
      evalSetId: 'test_eval_set',
      evalCases: [
        makeEvalCase({evalId: 'case1', conversation: []}),
        makeEvalCase({evalId: 'case2', conversation: []}),
        makeEvalCase({evalId: 'case3', conversation: []}),
      ],
    } as unknown as EvalSet;
    vi.mocked(evalSetsManager.getEvalSet).mockResolvedValue(evalSet);
    const spy = vi
      .spyOn(privates, 'performInferenceSingleEvalItem')
      .mockResolvedValue(makeInferenceResult({evalCaseId: 'case1'}));

    const results: InferenceResult[] = [];
    for await (const result of service.performInference({
      appName: 'test_app',
      evalSetId: 'test_eval_set',
      evalCaseIds: ['case1', 'case3'],
      inferenceConfig: {
        parallelism: 1,
        useLive: false,
        liveTimeoutSeconds: 300,
      },
    })) {
      results.push(result);
    }

    expect(results).toHaveLength(2);
    expect(spy).toHaveBeenCalledWith({
      appName: 'test_app',
      evalSetId: 'test_eval_set',
      evalCase: evalSet.evalCases[0],
    });
    expect(spy).toHaveBeenCalledWith({
      appName: 'test_app',
      evalSetId: 'test_eval_set',
      evalCase: evalSet.evalCases[2],
    });
  });

  it('throws when live inference is requested', async () => {
    const {service, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalSet).mockResolvedValue({
      evalSetId: 'test_eval_set',
      evalCases: [makeEvalCase({evalId: 'case1', conversation: []})],
    } as unknown as EvalSet);

    await expect(
      (async () => {
        for await (const _ of service.performInference({
          appName: 'test_app',
          evalSetId: 'test_eval_set',
          inferenceConfig: {
            parallelism: 1,
            useLive: true,
            liveTimeoutSeconds: 600,
          },
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/not yet supported/i);
  });

  it('throws NotFoundError when the eval set is missing', async () => {
    const {service, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalSet).mockResolvedValue(undefined);

    await expect(
      (async () => {
        for await (const _ of service.performInference({
          appName: 'test_app',
          evalSetId: 'not_found_set',
          inferenceConfig: {
            parallelism: 1,
            useLive: false,
            liveTimeoutSeconds: 300,
          },
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('LocalEvalService.evaluate', () => {
  it('streams results and saves them once per set', async () => {
    const {service, evalSetsManager, evalSetResultsManager} = makeService();
    const inferenceResults = [
      makeInferenceResult({
        evalCaseId: 'case1',
        inferences: [makeInvocation('user', 'final')],
        sessionId: 'session1',
      }),
      makeInferenceResult({
        evalCaseId: 'case2',
        inferences: [makeInvocation('user', 'final')],
        sessionId: 'session2',
      }),
    ];
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: [makeInvocation('user', 'final')]}),
    );

    const results: EvalCaseResult[] = [];
    for await (const result of service.evaluate({
      inferenceResults,
      evaluateConfig: {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 2,
      },
    })) {
      results.push(result);
    }

    expect(results).toHaveLength(2);
    expect(evalSetsManager.getEvalCase).toHaveBeenCalledTimes(2);
    expect(evalSetResultsManager.saveEvalSetResult).toHaveBeenCalledTimes(1);
    expect(evalSetResultsManager.saveEvalSetResult).toHaveBeenCalledWith(
      'test_app',
      'test_eval_set',
      expect.arrayContaining([expect.objectContaining({evalId: 'case1'})]),
    );
  });

  it('throws NotFoundError when the eval case is missing', async () => {
    const {service, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(undefined);

    await expect(
      (async () => {
        for await (const _ of service.evaluate({
          inferenceResults: [
            makeInferenceResult({evalCaseId: 'case1', inferences: []}),
          ],
          evaluateConfig: {
            evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
            parallelism: 1,
          },
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(NotFoundError);
    expect(evalSetsManager.getEvalCase).toHaveBeenCalledTimes(1);
  });

  it('persists results already scored when a later case fails', async () => {
    const {service, evalSetsManager, evalSetResultsManager} = makeService();
    // Sequential (parallelism 1): case1 scores, then case2 is missing.
    vi.mocked(evalSetsManager.getEvalCase).mockImplementation(
      async (_appName, _evalSetId, evalCaseId) =>
        evalCaseId === 'case1'
          ? makeEvalCase({conversation: [makeInvocation('user', 'final')]})
          : undefined,
    );

    const streamed: EvalCaseResult[] = [];
    await expect(
      (async () => {
        for await (const result of service.evaluate({
          inferenceResults: [
            makeInferenceResult({
              evalCaseId: 'case1',
              inferences: [makeInvocation('user', 'final')],
            }),
            makeInferenceResult({
              evalCaseId: 'case2',
              inferences: [makeInvocation('user', 'final')],
            }),
          ],
          evaluateConfig: {
            evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
            parallelism: 1,
          },
        })) {
          streamed.push(result);
        }
      })(),
    ).rejects.toThrow(NotFoundError);

    expect(streamed).toHaveLength(1);
    // The result computed before the failure is not discarded.
    expect(evalSetResultsManager.saveEvalSetResult).toHaveBeenCalledTimes(1);
    expect(evalSetResultsManager.saveEvalSetResult).toHaveBeenCalledWith(
      'test_app',
      'test_eval_set',
      [expect.objectContaining({evalId: 'case1'})],
    );
  });

  it('saves nothing when the consumer abandons the stream early', async () => {
    const {service, evalSetsManager, evalSetResultsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: [makeInvocation('user', 'final')]}),
    );

    for await (const _ of service.evaluate({
      inferenceResults: [
        makeInferenceResult({
          evalCaseId: 'case1',
          inferences: [makeInvocation('user', 'final')],
        }),
        makeInferenceResult({
          evalCaseId: 'case2',
          inferences: [makeInvocation('user', 'final')],
        }),
      ],
      evaluateConfig: {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    })) {
      break;
    }

    // An abandoned run must not persist a partial eval set result.
    expect(evalSetResultsManager.saveEvalSetResult).not.toHaveBeenCalled();
  });

  it('saves separately for two apps sharing an eval set id', async () => {
    const {service, evalSetsManager, evalSetResultsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: [makeInvocation('user', 'final')]}),
    );

    for await (const _ of service.evaluate({
      inferenceResults: [
        makeInferenceResult({
          appName: 'app_a',
          evalCaseId: 'case1',
          inferences: [makeInvocation('user', 'final')],
        }),
        makeInferenceResult({
          appName: 'app_b',
          evalCaseId: 'case2',
          inferences: [makeInvocation('user', 'final')],
        }),
      ],
      evaluateConfig: {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    })) {
      // drain
    }

    expect(evalSetResultsManager.saveEvalSetResult).toHaveBeenCalledTimes(2);
    expect(evalSetResultsManager.saveEvalSetResult).toHaveBeenCalledWith(
      'app_a',
      'test_eval_set',
      [expect.objectContaining({evalId: 'case1'})],
    );
    expect(evalSetResultsManager.saveEvalSetResult).toHaveBeenCalledWith(
      'app_b',
      'test_eval_set',
      [expect.objectContaining({evalId: 'case2'})],
    );
  });

  it('streams every result when parallelism is not a usable number', async () => {
    const {service, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: [makeInvocation('user', 'final')]}),
    );

    const results: EvalCaseResult[] = [];
    for await (const result of service.evaluate({
      inferenceResults: [
        makeInferenceResult({
          evalCaseId: 'case1',
          inferences: [makeInvocation('user', 'final')],
        }),
        makeInferenceResult({
          evalCaseId: 'case2',
          inferences: [makeInvocation('user', 'final')],
        }),
      ],
      // A hand-built config that bypasses the schema default must not
      // silently produce an empty run.
      evaluateConfig: {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: Number.NaN,
      },
    })) {
      results.push(result);
    }

    expect(results).toHaveLength(2);
  });

  it('streams results without a results manager', async () => {
    const {service, evalSetsManager} = makeService({
      evalSetResultsManager: undefined,
    });
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: [makeInvocation('user', 'final')]}),
    );

    const results: EvalCaseResult[] = [];
    for await (const result of service.evaluate({
      inferenceResults: [
        makeInferenceResult({
          evalCaseId: 'case1',
          inferences: [makeInvocation('user', 'final')],
        }),
      ],
      evaluateConfig: {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    })) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
  });
});

describe('LocalEvalService.evaluateSingleInferenceResult', () => {
  it('scores each invocation for a two-sided metric', async () => {
    const {privates, evalSetsManager} = makeService();
    const inferences = [
      makeInvocation('user', 'final'),
      makeInvocation('user', 'final'),
      makeInvocation('user', 'final'),
    ];
    const conversation = [
      makeInvocation('user', 'final'),
      makeInvocation('user', 'final'),
      makeInvocation('user', 'final'),
    ];
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation}),
    );

    const [, result] = await privates.evaluateSingleInferenceResult(
      makeInferenceResult({
        evalCaseId: 'case1',
        inferences,
        sessionId: 'session1',
      }),
      {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    );

    expect(result.evalId).toBe('case1');
    expect(result.sessionId).toBe('session1');
    expect(result.overallEvalMetricResults).toHaveLength(1);
    expect(result.overallEvalMetricResults[0].metricName).toBe('fake_metric');
    expect(result.overallEvalMetricResults[0].score).toBe(0.9);
    expect(evalSetsManager.getEvalCase).toHaveBeenCalledWith(
      'test_app',
      'test_eval_set',
      'case1',
    );
    expect(result.evalMetricResultPerInvocation).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const perInvocation = result.evalMetricResultPerInvocation[i];
      expect(perInvocation.actualInvocation).toBe(inferences[i]);
      expect(perInvocation.expectedInvocation).toBe(conversation[i]);
      expect(perInvocation.evalMetricResults).toHaveLength(1);
      expect(perInvocation.evalMetricResults[0].metricName).toBe('fake_metric');
      expect(perInvocation.evalMetricResults[0].score).toBe(0.9);
      expect(perInvocation.evalMetricResults[0].evalStatus).toBe(
        EvalStatus.PASSED,
      );
    }
  });

  it('uses the user id from the eval case session input', async () => {
    const {privates, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({
        conversation: [makeInvocation('user', 'final')],
        sessionInput: {appName: 'test_app', userId: 'custom_user', state: {}},
      }),
    );

    const [, result] = await privates.evaluateSingleInferenceResult(
      makeInferenceResult({
        evalCaseId: 'case1',
        inferences: [makeInvocation('user', 'final')],
      }),
      {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    );

    expect(result.userId).toBe('custom_user');
  });

  it('returns a FAILED result when there are no inferences', async () => {
    const {privates, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: []}),
    );

    const [, result] = await privates.evaluateSingleInferenceResult(
      makeInferenceResult({
        evalCaseId: 'case1',
        inferences: undefined,
        sessionId: 'session1',
        status: InferenceStatus.FAILURE,
        errorMessage: 'auth failed',
      }),
      {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    );

    expect(result.evalId).toBe('case1');
    expect(result.sessionId).toBe('session1');
    expect(result.finalEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.overallEvalMetricResults).toEqual([]);
    expect(result.evalMetricResultPerInvocation).toEqual([]);
  });

  it('returns a FAILED result with an empty session id when none is set', async () => {
    const {privates, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: []}),
    );

    const [, result] = await privates.evaluateSingleInferenceResult(
      makeInferenceResult({
        evalCaseId: 'case1',
        inferences: undefined,
        sessionId: null,
        status: InferenceStatus.FAILURE,
      }),
      {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    );

    expect(result.finalEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.sessionId).toBe('');
    expect(result.sessionDetails).toBeUndefined();
  });

  it('throws when there is no conversation to match inferences against', async () => {
    const {privates, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: undefined, conversationScenario: undefined}),
    );

    await expect(
      privates.evaluateSingleInferenceResult(
        makeInferenceResult({
          evalCaseId: 'case1',
          inferences: [makeInvocation('user', 'final')],
        }),
        {
          evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
          parallelism: 1,
        },
      ),
    ).rejects.toThrow(/Inferences should match conversations/);
  });

  it('scores a single-sided metric for a conversation scenario', async () => {
    const {privates, evalSetsManager} = makeService();
    const inferences = [
      makeInvocation('user', 'final'),
      makeInvocation('user', 'final'),
      makeInvocation('user', 'final'),
    ];
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({
        conversation: undefined,
        conversationScenario: {} as unknown as ConversationScenario,
      }),
    );

    const [, result] = await privates.evaluateSingleInferenceResult(
      makeInferenceResult({
        evalCaseId: 'case1',
        inferences,
        sessionId: 'session1',
      }),
      {
        evalMetrics: [{metricName: 'fake_single_sided_metric', threshold: 0.5}],
        parallelism: 1,
      },
    );

    expect(result.finalEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.overallEvalMetricResults[0].metricName).toBe(
      'fake_single_sided_metric',
    );
    expect(result.overallEvalMetricResults[0].score).toBe(0.95);
    expect(result.evalMetricResultPerInvocation).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const perInvocation = result.evalMetricResultPerInvocation[i];
      expect(perInvocation.actualInvocation).toBe(inferences[i]);
      expect(perInvocation.expectedInvocation).toBeUndefined();
      expect(perInvocation.evalMetricResults[0].score).toBe(0.995);
      expect(perInvocation.evalMetricResults[0].evalStatus).toBe(
        EvalStatus.PASSED,
      );
    }
  });

  it('downgrades to NOT_EVALUATED when a metric throws', async () => {
    const {privates, evalSetsManager} = makeService();
    const inferences = [
      makeInvocation('user', 'final'),
      makeInvocation('user', 'final'),
      makeInvocation('user', 'final'),
    ];
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({
        conversation: undefined,
        conversationScenario: {} as unknown as ConversationScenario,
      }),
    );

    const [, result] = await privates.evaluateSingleInferenceResult(
      makeInferenceResult({
        evalCaseId: 'case1',
        inferences,
        sessionId: 'session1',
      }),
      {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    );

    expect(result.finalEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.overallEvalMetricResults[0].metricName).toBe('fake_metric');
    expect(result.overallEvalMetricResults[0].score).toBeUndefined();
    expect(result.evalMetricResultPerInvocation).toHaveLength(3);
  });

  it('throws when inference count does not match the conversation', async () => {
    const {privates, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: [makeInvocation('user', 'final')]}),
    );

    await expect(
      privates.evaluateSingleInferenceResult(
        makeInferenceResult({
          evalCaseId: 'case1',
          inferences: [
            makeInvocation('user', 'final'),
            makeInvocation('user', 'final'),
          ],
        }),
        {
          evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
          parallelism: 1,
        },
      ),
    ).rejects.toThrow(
      'Inferences should match conversations in eval case. Found 2 inferences' +
        ' and 1 conversations in eval cases.',
    );
  });

  it('handles a null session id', async () => {
    const {privates, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: [makeInvocation('user', 'final')]}),
    );

    const [, result] = await privates.evaluateSingleInferenceResult(
      makeInferenceResult({
        evalCaseId: 'case1',
        inferences: [makeInvocation('user', 'final')],
        sessionId: null,
      }),
      {
        evalMetrics: [{metricName: 'fake_metric', threshold: 0.5}],
        parallelism: 1,
      },
    );

    expect(result.sessionId).toBe('');
    expect(result.sessionDetails).toBeUndefined();
  });

  it('throws when a metric returns a mismatched result count', async () => {
    const {privates, evalSetsManager} = makeService();
    vi.mocked(evalSetsManager.getEvalCase).mockResolvedValue(
      makeEvalCase({conversation: [makeInvocation('user', 'final')]}),
    );

    await expect(
      privates.evaluateSingleInferenceResult(
        makeInferenceResult({
          evalCaseId: 'case1',
          inferences: [makeInvocation('user', 'final')],
        }),
        {
          evalMetrics: [{metricName: 'fake_mismatch_metric', threshold: 0.5}],
          parallelism: 1,
        },
      ),
    ).rejects.toThrow(/should return results for each invocation/);
  });
});

describe('LocalEvalService.performInferenceSingleEvalItem', () => {
  it('runs non-live inference and reports success', async () => {
    const mockUserSim = {} as unknown as UserSimulator;
    const userSimulatorProvider = {
      provide: vi.fn().mockReturnValue(mockUserSim),
    } as unknown as UserSimulatorProvider;
    const {privates, rootAgent} = makeService({
      sessionIdSupplier: () => 'test_session_id',
      userSimulatorProvider,
    });
    const generateSpy = vi
      .spyOn(EvaluationGenerator, 'generateInferencesFromRootAgent')
      .mockResolvedValue([]);
    const evalCase = makeEvalCase({conversation: []});

    const result = await privates.performInferenceSingleEvalItem({
      appName: 'test_app',
      evalSetId: 'test_eval_set',
      evalCase,
    });

    expect(generateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rootAgent,
        userSimulator: mockUserSim,
        initialSession: undefined,
        sessionId: 'test_session_id',
      }),
    );
    expect(result.status).toBe(InferenceStatus.SUCCESS);
    expect(result.inferences).toEqual([]);
    expect(result.sessionId).toBe('test_session_id');
  });

  it('reports failure when inference throws', async () => {
    const {privates} = makeService({
      userSimulatorProvider: {
        provide: () => ({}) as unknown as UserSimulator,
      } as unknown as UserSimulatorProvider,
    });
    vi.spyOn(
      EvaluationGenerator,
      'generateInferencesFromRootAgent',
    ).mockRejectedValue(new Error('boom'));

    const result = await privates.performInferenceSingleEvalItem({
      appName: 'test_app',
      evalSetId: 'test_eval_set',
      evalCase: makeEvalCase({conversation: []}),
    });

    expect(result.status).toBe(InferenceStatus.FAILURE);
    expect(result.errorMessage).toContain('boom');
  });
});

describe('generateFinalEvalStatus', () => {
  function metricResult(evalStatus: EvalStatus): EvalMetricResult {
    return {metricName: 'metric1', threshold: 0.5, evalStatus, details: {}};
  }

  it('does not throw for any known EvalStatus', () => {
    const statuses = Object.values(EvalStatus).filter(
      (value): value is EvalStatus => typeof value === 'number',
    );
    for (const status of statuses) {
      expect(() =>
        generateFinalEvalStatus([metricResult(status)]),
      ).not.toThrow();
    }
  });

  it('returns PASSED when any metric passes and none fail', () => {
    expect(generateFinalEvalStatus([metricResult(EvalStatus.PASSED)])).toBe(
      EvalStatus.PASSED,
    );
  });

  it('short-circuits to FAILED', () => {
    expect(
      generateFinalEvalStatus([
        metricResult(EvalStatus.PASSED),
        metricResult(EvalStatus.FAILED),
      ]),
    ).toBe(EvalStatus.FAILED);
  });

  it('skips NOT_EVALUATED and defaults to NOT_EVALUATED', () => {
    expect(
      generateFinalEvalStatus([metricResult(EvalStatus.NOT_EVALUATED)]),
    ).toBe(EvalStatus.NOT_EVALUATED);
    expect(generateFinalEvalStatus([])).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('throws on an unknown eval status', () => {
    expect(() =>
      generateFinalEvalStatus([metricResult(999 as EvalStatus)]),
    ).toThrow(/Unknown eval status/);
  });
});

describe('rubric helpers', () => {
  const rubric1: Rubric = {
    rubricId: 'r1',
    rubricContent: {textProperty: 'p1'},
  };
  const rubric2: Rubric = {
    rubricId: 'r2',
    rubricContent: {textProperty: 'p2'},
  };

  it('initializes the rubrics list', () => {
    const invocation = makeInvocation('actual');
    addRubricsToInvocation(invocation, [rubric1]);
    expect(invocation.rubrics).toEqual([rubric1]);
  });

  it('appends to an existing rubrics list', () => {
    const invocation = {...makeInvocation('actual'), rubrics: [rubric1]};
    addRubricsToInvocation(invocation, [rubric2]);
    expect(invocation.rubrics).toEqual([rubric1, rubric2]);
  });

  it('throws on a duplicate rubric id', () => {
    const invocation = {...makeInvocation('actual'), rubrics: [rubric1]};
    const duplicate: Rubric = {
      rubricId: 'r1',
      rubricContent: {textProperty: 'p2'},
    };
    expect(() => addRubricsToInvocation(invocation, [duplicate])).toThrow(
      /already exists/,
    );
  });

  it('copies eval-case rubrics onto all invocations', () => {
    const evalCase = makeEvalCase({conversation: [], rubrics: [rubric1]});
    const invocations = [makeInvocation('a1'), makeInvocation('a2')];
    copyEvalCaseRubricsToActualInvocations(evalCase, invocations);
    expect(invocations[0].rubrics).toEqual([rubric1]);
    expect(invocations[1].rubrics).toEqual([rubric1]);
  });

  it('does nothing when the eval case has no rubrics', () => {
    const evalCase = makeEvalCase({conversation: []});
    const invocations = [makeInvocation('a1')];
    copyEvalCaseRubricsToActualInvocations(evalCase, invocations);
    expect(invocations[0].rubrics).toBeUndefined();
  });

  it('copies invocation rubrics onto aligned actual invocations', () => {
    const expected = [
      {...makeInvocation('e1'), rubrics: [rubric1]},
      {...makeInvocation('e2'), rubrics: [rubric2]},
      {...makeInvocation('e3')},
    ];
    const actual = [
      makeInvocation('a1'),
      makeInvocation('a2'),
      makeInvocation('a3'),
    ];
    copyInvocationRubricsToActualInvocations(expected, actual);
    expect(actual[0].rubrics).toEqual([rubric1]);
    expect(actual[1].rubrics).toEqual([rubric2]);
    expect(actual[2].rubrics).toBeUndefined();
  });

  it('does nothing when there are no expected invocations', () => {
    const actual = [makeInvocation('a1')];
    copyInvocationRubricsToActualInvocations(undefined, actual);
    expect(actual[0].rubrics).toBeUndefined();
  });
});

describe('getSessionId', () => {
  it('produces prefixed, unique session ids', () => {
    const first = getSessionId();
    const second = getSessionId();
    expect(first).toMatch(/^___eval___session___/);
    expect(first).not.toBe(second);
  });
});
