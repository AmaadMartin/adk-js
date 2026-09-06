/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  AsyncQueue,
  BaseLlm,
  BaseLlmConnection,
  EVAL_SESSION_ID_PREFIX,
  EvalStatus,
  InMemoryArtifactService,
  InMemorySessionService,
  InputValidationError,
  LlmAgent,
  LlmResponse,
  LocalEvalService,
  MetricEvaluatorRegistry,
  NotFoundError,
  UserSimulatorProvider,
  UserSimulatorStatus,
  createEvalSessionId,
  emptyEvaluationResult,
  generateFinalEvalStatus,
  type ConversationScenario,
  type EvalCase,
  type EvalCaseResult,
  type EvalMetric,
  type EvalMetricResult,
  type EvalSet,
  type EvalSetResult,
  type EvalSetResultsManager,
  type EvalSetsManager,
  type EvaluationResult,
  type Evaluator,
  type InferenceResult,
  type Invocation,
  type NextUserMessage,
  type UserSimulator,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ScriptedLlm} from './test_helpers.js';

type EvaluationGeneratorModule =
  typeof import('../../src/evaluation/evaluation_generator.js');

/** The parameters each generator call was made with, in call order. */
interface RecordedCall {
  live: boolean;
  sessionId?: string;
  /**
   * Compared by identity only. It is typed loosely because the generator
   * module is imported by path here, so its `App` is a different declaration
   * from the `App` the package entry point exports.
   */
  app?: unknown;
  liveTimeoutSeconds?: number;
}

const generatorCalls: RecordedCall[] = [];

// The generator runs for real; the wrapper only records how the service
// called it, which is the part behaviour alone cannot show.
vi.mock(
  '../../src/evaluation/evaluation_generator.js',
  async (importOriginal) => {
    const actual = await importOriginal<EvaluationGeneratorModule>();
    return {
      ...actual,
      generateInferencesFromRootAgent: (
        params: Parameters<
          EvaluationGeneratorModule['generateInferencesFromRootAgent']
        >[0],
      ) => {
        generatorCalls.push({
          live: false,
          sessionId: params.sessionId,
          app: params.app,
        });
        return actual.generateInferencesFromRootAgent(params);
      },
      generateInferencesFromRootAgentLive: (
        params: Parameters<
          EvaluationGeneratorModule['generateInferencesFromRootAgentLive']
        >[0],
      ) => {
        generatorCalls.push({
          live: true,
          sessionId: params.sessionId,
          app: params.app,
          liveTimeoutSeconds: params.liveTimeoutSeconds,
        });
        return actual.generateInferencesFromRootAgentLive(params);
      },
    };
  },
);

const APP_NAME = 'test_app';
const EVAL_SET_ID = 'test_eval_set';
const FAKE_METRIC: EvalMetric = {metricName: 'fake_metric', threshold: 0.5};
const FAKE_SINGLE_SIDED_METRIC: EvalMetric = {
  metricName: 'fake_single_sided_metric',
  threshold: 0.5,
};

const SCENARIO: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan: 'Book a one-way flight.',
};

function invocation(text = 'test final response.'): Invocation {
  return {
    invocationId: 'invocation_1',
    userContent: {role: 'user', parts: [{text: 'test user content.'}]},
    finalResponse: {role: 'model', parts: [{text}]},
    creationTimestamp: 0,
  };
}

/** Scores against the golden turns, and refuses to run without them. */
class FakeEvaluator implements Evaluator {
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult {
    if (expectedInvocations === undefined) {
      throw new InputValidationError(
        'expectedInvocations is required for this metric.',
      );
    }
    return {
      overallScore: 0.9,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: actualInvocations.map((actual, index) => ({
        actualInvocation: actual,
        expectedInvocation: expectedInvocations[index],
        score: 0.9,
        evalStatus: EvalStatus.PASSED,
      })),
    };
  }
}

/** Scores without golden turns, and records the scenario it was given. */
class FakeSingleSidedEvaluator implements Evaluator {
  static readonly scenarios: Array<ConversationScenario | undefined> = [];

  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult {
    FakeSingleSidedEvaluator.scenarios.push(conversationScenario);
    return {
      overallScore: 0.95,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: actualInvocations.map((actual) => ({
        actualInvocation: actual,
        score: 0.995,
        evalStatus: EvalStatus.PASSED,
      })),
    };
  }
}

/** Claims to have evaluated, but returns no per-invocation results. */
class UnderreportingEvaluator implements Evaluator {
  evaluateInvocations(): EvaluationResult {
    return {
      overallScore: 1,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: [],
    };
  }
}

function registryWithFakes(): MetricEvaluatorRegistry {
  const registry = new MetricEvaluatorRegistry();
  registry.registerEvaluator(FAKE_METRIC.metricName, () => new FakeEvaluator());
  registry.registerEvaluator(
    FAKE_SINGLE_SIDED_METRIC.metricName,
    () => new FakeSingleSidedEvaluator(),
  );
  return registry;
}

/** An eval set store backed by a map, so a test can seed and read it. */
class FakeEvalSetsManager implements EvalSetsManager {
  readonly getEvalSetCalls: Array<[string, string]> = [];
  readonly getEvalCaseCalls: Array<[string, string, string]> = [];
  private readonly evalSets = new Map<string, EvalSet>();
  private evalCase?: EvalCase;

  /** Seeds the set `getEvalSet` returns for `evalSetId`. */
  setEvalSet(evalSetId: string, evalSet: EvalSet): void {
    this.evalSets.set(evalSetId, evalSet);
  }

  /** Seeds the case `getEvalCase` returns, whatever the case id. */
  setEvalCase(evalCase: EvalCase | undefined): void {
    this.evalCase = evalCase;
  }

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    this.getEvalSetCalls.push([appName, evalSetId]);
    return this.evalSets.get(evalSetId);
  }

  async getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined> {
    this.getEvalCaseCalls.push([appName, evalSetId, evalCaseId]);
    return this.evalCase;
  }

  async createEvalSet(): Promise<EvalSet> {
    throw new Error('createEvalSet is not part of this test.');
  }

  async listEvalSets(): Promise<string[]> {
    throw new Error('listEvalSets is not part of this test.');
  }

  async addEvalCase(): Promise<void> {
    throw new Error('addEvalCase is not part of this test.');
  }

  async updateEvalCase(): Promise<void> {
    throw new Error('updateEvalCase is not part of this test.');
  }

  async deleteEvalCase(): Promise<void> {
    throw new Error('deleteEvalCase is not part of this test.');
  }
}

/** Records what was saved, so a test can check the grouping. */
class RecordingEvalSetResultsManager implements EvalSetResultsManager {
  readonly saved: Array<{
    appName: string;
    evalSetId: string;
    evalCaseResults: EvalCaseResult[];
  }> = [];

  async saveEvalSetResult(
    appName: string,
    evalSetId: string,
    evalCaseResults: EvalCaseResult[],
  ): Promise<void> {
    this.saved.push({appName, evalSetId, evalCaseResults});
  }

  async getEvalSetResult(): Promise<EvalSetResult> {
    throw new Error('getEvalSetResult is not part of this test.');
  }

  async listEvalSetResults(): Promise<string[]> {
    throw new Error('listEvalSetResults is not part of this test.');
  }
}

/** Replays a fixed list of user turns, then stops the conversation. */
class ScriptedUserSimulator implements UserSimulator {
  private turn = 0;

  constructor(
    private readonly messages: string[],
    private readonly gate?: Promise<void>,
  ) {}

  async getNextUserMessage(): Promise<NextUserMessage> {
    await this.gate;
    if (this.turn >= this.messages.length) {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }
    const text = this.messages[this.turn];
    this.turn++;
    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: {role: 'user', parts: [{text}]},
    };
  }
}

/** Fails the conversation, so the inference for that case fails. */
class FailingUserSimulator implements UserSimulator {
  constructor(private readonly message: string) {}

  async getNextUserMessage(): Promise<NextUserMessage> {
    throw new Error(this.message);
  }
}

/** Hands each eval case the simulator the test chose for it. */
class FixedSimulatorProvider extends UserSimulatorProvider {
  constructor(
    private readonly simulatorFor: (evalCase: EvalCase) => UserSimulator,
  ) {
    super();
  }

  override provide(evalCase: EvalCase): UserSimulator {
    return this.simulatorFor(evalCase);
  }
}

/** A live model that answers each turn with one word, then completes it. */
class OneWordLiveLlm extends BaseLlm {
  constructor() {
    super({model: 'one-word-live-llm'});
  }

  generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('OneWordLiveLlm only serves the live path.');
  }

  async connect(): Promise<BaseLlmConnection> {
    return new OneWordLiveConnection();
  }
}

class OneWordLiveConnection implements BaseLlmConnection {
  private readonly responses = new AsyncQueue<LlmResponse>();

  async sendHistory(): Promise<void> {}

  async sendContent(): Promise<void> {
    this.reply();
  }

  async sendRealtime(): Promise<void> {}

  async sendActivityStart(): Promise<void> {}

  async sendActivityEnd(): Promise<void> {
    this.reply();
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for await (const response of this.responses) {
      yield response;
    }
  }

  async close(): Promise<void> {
    this.responses.close();
  }

  private reply(): void {
    this.responses.push({content: {role: 'model', parts: [{text: 'sunny'}]}});
    this.responses.push({turnComplete: true});
  }
}

function scriptedAgent(): LlmAgent {
  return new LlmAgent({
    name: 'test_agent',
    model: new ScriptedLlm(['test final response.']),
  });
}

function evalSetWith(...evalIds: string[]): EvalSet {
  return {
    evalSetId: EVAL_SET_ID,
    creationTimestamp: 0,
    evalCases: evalIds.map((evalId) => ({
      evalId,
      conversation: [invocation()],
    })),
  };
}

function inferenceResult(
  overrides: Partial<InferenceResult> = {},
): InferenceResult {
  return {
    appName: APP_NAME,
    evalSetId: EVAL_SET_ID,
    evalCaseId: 'case1',
    inferences: [invocation()],
    sessionId: 'session1',
    status: 1,
    ...overrides,
  };
}

let evalSetsManager: FakeEvalSetsManager;
let resultsManager: RecordingEvalSetResultsManager;

function createService(
  overrides: Partial<ConstructorParameters<typeof LocalEvalService>[0]> = {},
): LocalEvalService {
  return new LocalEvalService({
    rootAgent: scriptedAgent(),
    evalSetsManager,
    evalSetResultsManager: resultsManager,
    metricEvaluatorRegistry: registryWithFakes(),
    userSimulatorProvider: new FixedSimulatorProvider(
      () => new ScriptedUserSimulator(['hello']),
    ),
    ...overrides,
  });
}

async function drain<T>(results: AsyncGenerator<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const result of results) {
    collected.push(result);
  }
  return collected;
}

beforeEach(() => {
  generatorCalls.length = 0;
  FakeSingleSidedEvaluator.scenarios.length = 0;
  evalSetsManager = new FakeEvalSetsManager();
  resultsManager = new RecordingEvalSetResultsManager();
});

describe('createEvalSessionId', () => {
  it('marks the id as one an eval run owns', () => {
    expect(createEvalSessionId()).toMatch(
      new RegExp(`^${EVAL_SESSION_ID_PREFIX}.+`),
    );
  });

  it('returns a different id every time', () => {
    expect(createEvalSessionId()).not.toBe(createEvalSessionId());
  });
});

describe('LocalEvalService.performInference', () => {
  it('yields one result per eval case', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, evalSetWith('case1', 'case2'));

    const results = await drain(
      createService().performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false, parallelism: 2},
      }),
    );

    expect(results.map((r) => r.evalCaseId).sort()).toEqual(['case1', 'case2']);
    expect(results.every((r) => r.status === 1)).toBe(true);
    expect(evalSetsManager.getEvalSetCalls).toEqual([[APP_NAME, EVAL_SET_ID]]);
  });

  it('runs only the requested eval cases', async () => {
    evalSetsManager.setEvalSet(
      EVAL_SET_ID,
      evalSetWith('case1', 'case2', 'case3'),
    );

    const results = await drain(
      createService().performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        evalCaseIds: ['case1', 'case3'],
        inferenceConfig: {useLive: false, parallelism: 1},
      }),
    );

    expect(results.map((r) => r.evalCaseId)).toEqual(['case1', 'case3']);
  });

  it('runs the whole set when the requested case list is empty', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, evalSetWith('case1', 'case2'));

    const results = await drain(
      createService().performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        evalCaseIds: [],
        inferenceConfig: {useLive: false, parallelism: 1},
      }),
    );

    expect(results).toHaveLength(2);
  });

  it('throws when the app has no such eval set', async () => {
    const results = createService().performInference({
      appName: APP_NAME,
      evalSetId: 'not_found_set',
      inferenceConfig: {useLive: false, parallelism: 1},
    });

    await expect(results.next()).rejects.toThrow(NotFoundError);
  });

  it('reports a failed case without stopping its siblings', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, evalSetWith('case1', 'case2'));
    const service = createService({
      userSimulatorProvider: new FixedSimulatorProvider((evalCase) =>
        evalCase.evalId === 'case1'
          ? new FailingUserSimulator('the simulator failed')
          : new ScriptedUserSimulator(['hello']),
      ),
    });

    const results = await drain(
      service.performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false, parallelism: 2},
      }),
    );

    const failed = results.find((r) => r.evalCaseId === 'case1');
    const succeeded = results.find((r) => r.evalCaseId === 'case2');
    expect(failed?.status).toBe(2);
    expect(failed?.errorMessage).toContain('the simulator failed');
    expect(failed?.inferences).toBeUndefined();
    expect(succeeded?.status).toBe(1);
  });

  it('reports a case the simulator provider refuses to drive', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, {
      evalSetId: EVAL_SET_ID,
      creationTimestamp: 0,
      evalCases: [
        // The shipped provider refuses a case with no static conversation.
        {evalId: 'case1', conversationScenario: SCENARIO},
        {evalId: 'case2', conversation: [invocation()]},
      ],
    });
    const service = createService({
      userSimulatorProvider: new UserSimulatorProvider(),
    });

    const results = await drain(
      service.performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false, parallelism: 2},
      }),
    );

    expect(results).toHaveLength(2);
    const refused = results.find((r) => r.evalCaseId === 'case1');
    expect(refused?.status).toBe(2);
    expect(refused?.errorMessage).toContain(
      'Neither static invocations nor conversation scenario provided',
    );
    expect(results.find((r) => r.evalCaseId === 'case2')?.status).toBe(1);
  });

  it('generates a session id when the pinned one is empty', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, {
      evalSetId: EVAL_SET_ID,
      creationTimestamp: 0,
      evalCases: [
        {
          evalId: 'case1',
          conversation: [invocation()],
          sessionInput: {appName: APP_NAME, userId: 'u', sessionId: ''},
        },
      ],
    });

    const results = await drain(
      createService({
        sessionIdSupplier: () => 'generated_id',
      }).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false},
      }),
    );

    expect(results[0].sessionId).toBe('generated_id');
    expect(generatorCalls[0].sessionId).toBe('generated_id');
  });

  it('runs no more cases at a time than the parallelism allows', async () => {
    evalSetsManager.setEvalSet(
      EVAL_SET_ID,
      evalSetWith('case1', 'case2', 'case3', 'case4'),
    );
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live = 0;
    let highWaterMark = 0;
    const service = createService({
      userSimulatorProvider: new FixedSimulatorProvider(() => {
        live++;
        highWaterMark = Math.max(highWaterMark, live);
        return new ScriptedUserSimulator(
          ['hello'],
          gate.then(() => {
            live--;
          }),
        );
      }),
    });

    const results = service.performInference({
      appName: APP_NAME,
      evalSetId: EVAL_SET_ID,
      inferenceConfig: {useLive: false, parallelism: 2},
    });
    const drained = drain(results);
    await Promise.resolve();
    release();

    expect(await drained).toHaveLength(4);
    expect(highWaterMark).toBe(2);
  });

  it('sends the non-live generator the id it generated, and no app', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, evalSetWith('case1'));

    const results = await drain(
      createService({sessionIdSupplier: () => 'generated_id'}).performInference(
        {
          appName: APP_NAME,
          evalSetId: EVAL_SET_ID,
          inferenceConfig: {useLive: false},
        },
      ),
    );

    expect(generatorCalls).toEqual([
      {live: false, sessionId: 'generated_id', app: undefined},
    ]);
    expect(results[0].sessionId).toBe('generated_id');
  });

  it('sends the non-live generator the app it was built with', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, evalSetWith('case1'));
    const rootAgent = scriptedAgent();
    const app = new App({name: APP_NAME, rootAgent});

    await drain(
      createService({rootAgent, app}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false},
      }),
    );

    expect(generatorCalls[0].app).toBe(app);
  });

  it('routes a live run to the live generator with the given timeout', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, evalSetWith('case1'));
    const rootAgent = new LlmAgent({
      name: 'live_agent',
      model: new OneWordLiveLlm(),
    });
    const app = new App({name: APP_NAME, rootAgent});

    const results = await drain(
      createService({rootAgent, app}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {
          useLive: true,
          liveTimeoutSeconds: 600,
          parallelism: 1,
        },
      }),
    );

    expect(generatorCalls[0].live).toBe(true);
    expect(generatorCalls[0].liveTimeoutSeconds).toBe(600);
    expect(generatorCalls[0].app).toBe(app);
    expect(results[0].status).toBe(1);
  });

  it('falls back to the default live timeout', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, evalSetWith('case1'));
    const rootAgent = new LlmAgent({
      name: 'live_agent',
      model: new OneWordLiveLlm(),
    });

    await drain(
      createService({rootAgent}).performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: true},
      }),
    );

    expect(generatorCalls[0].liveTimeoutSeconds).toBe(300);
  });

  it('keeps a pinned session id and leaves its artifacts reachable', async () => {
    const sessionInput = {appName: APP_NAME, userId: 'u', sessionId: 'fixed'};
    evalSetsManager.setEvalSet(EVAL_SET_ID, {
      evalSetId: EVAL_SET_ID,
      creationTimestamp: 0,
      evalCases: [
        {evalId: 'case1', conversation: [invocation()], sessionInput},
      ],
    });
    const artifactService = new InMemoryArtifactService();
    await artifactService.saveArtifact({
      appName: APP_NAME,
      userId: 'u',
      sessionId: 'fixed',
      filename: 'doc.txt',
      artifact: {text: 'hello'},
    });
    const sessionIdSupplier = vi.fn(() => 'generated_id');
    const service = createService({artifactService, sessionIdSupplier});

    const results: InferenceResult[] = [];
    for (let run = 0; run < 2; run++) {
      results.push(
        ...(await drain(
          service.performInference({
            appName: APP_NAME,
            evalSetId: EVAL_SET_ID,
            inferenceConfig: {useLive: false, parallelism: 1},
          }),
        )),
      );
    }

    expect(sessionIdSupplier).not.toHaveBeenCalled();
    expect(results.map((r) => r.sessionId)).toEqual(['fixed', 'fixed']);
    expect(results.every((r) => r.status === 1)).toBe(true);
    // The pinned id travels only inside `initialSession`.
    expect(generatorCalls.map((call) => call.sessionId)).toEqual([
      undefined,
      undefined,
    ]);
    const loaded = await artifactService.loadArtifact({
      appName: APP_NAME,
      userId: 'u',
      sessionId: 'fixed',
      filename: 'doc.txt',
    });
    expect(loaded?.text).toBe('hello');
  });
});

describe('LocalEvalService.evaluate', () => {
  it('yields one result per inference result and saves the set once', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });

    const results = await drain(
      createService().evaluate({
        inferenceResults: [
          inferenceResult({evalCaseId: 'case1'}),
          inferenceResult({evalCaseId: 'case2'}),
        ],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 2},
      }),
    );

    expect(results).toHaveLength(2);
    expect(evalSetsManager.getEvalCaseCalls).toHaveLength(2);
    expect(resultsManager.saved).toHaveLength(1);
    expect(resultsManager.saved[0].evalSetId).toBe(EVAL_SET_ID);
    expect(resultsManager.saved[0].appName).toBe(APP_NAME);
    expect(resultsManager.saved[0].evalCaseResults).toHaveLength(2);
  });

  it('saves once per eval set', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });

    await drain(
      createService().evaluate({
        inferenceResults: [
          inferenceResult({evalSetId: 'set_a'}),
          inferenceResult({evalSetId: 'set_b'}),
        ],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(resultsManager.saved.map((s) => s.evalSetId).sort()).toEqual([
      'set_a',
      'set_b',
    ]);
  });

  it('saves nothing when no results manager was given', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });
    const service = createService({evalSetResultsManager: undefined});

    const results = await drain(
      service.evaluate({
        inferenceResults: [inferenceResult()],
        evaluateConfig: {evalMetrics: [FAKE_METRIC]},
      }),
    );

    expect(results).toHaveLength(1);
    expect(resultsManager.saved).toEqual([]);
  });

  it('saves nothing when the consumer stops reading early', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });

    for await (const result of createService().evaluate({
      inferenceResults: [inferenceResult(), inferenceResult()],
      evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
    })) {
      expect(result.evalId).toBe('case1');
      break;
    }

    expect(resultsManager.saved).toEqual([]);
  });

  it('throws when the eval set does not hold the case', async () => {
    evalSetsManager.setEvalCase(undefined);

    await expect(
      drain(
        createService().evaluate({
          inferenceResults: [inferenceResult()],
          evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
        }),
      ),
    ).rejects.toThrow(NotFoundError);
    expect(evalSetsManager.getEvalCaseCalls).toHaveLength(1);
  });

  it('scores every invocation against its golden turn', async () => {
    const expectedInvocations = [invocation(), invocation(), invocation()];
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: expectedInvocations,
    });
    const inferences = [invocation(), invocation(), invocation()];

    const [result] = await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult({inferences})],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(result.evalId).toBe('case1');
    expect(result.sessionId).toBe('session1');
    expect(result.finalEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.overallEvalMetricResults).toEqual([
      {
        ...FAKE_METRIC,
        score: 0.9,
        evalStatus: EvalStatus.PASSED,
        details: {rubricScores: undefined},
      },
    ]);
    expect(result.evalMetricResultPerInvocation).toHaveLength(3);
    result.evalMetricResultPerInvocation.forEach((entry, index) => {
      expect(entry.actualInvocation).toBe(inferences[index]);
      expect(entry.expectedInvocation).toBe(expectedInvocations[index]);
      expect(entry.evalMetricResults).toEqual([
        {
          ...FAKE_METRIC,
          score: 0.9,
          evalStatus: EvalStatus.PASSED,
          details: {rubricScores: undefined},
        },
      ]);
    });
  });

  it('fails a case whose inference produced nothing', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [],
      sessionInput: {appName: APP_NAME, userId: 'pinned_user'},
    });

    const [result] = await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult({inferences: undefined, status: 2})],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(result.finalEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.overallEvalMetricResults).toEqual([]);
    expect(result.evalMetricResultPerInvocation).toEqual([]);
    expect(result.userId).toBe('pinned_user');
    expect(result.sessionId).toBe('session1');
  });

  it('reports an empty session id when the inference recorded none', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });

    const [result] = await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult({sessionId: undefined})],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(result.sessionId).toBe('');
    expect(result.sessionDetails).toBeUndefined();
  });

  it('reports the session the inference ran in', async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: 'test_user_id',
      sessionId: 'session1',
    });
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });

    const [result] = await drain(
      createService({sessionService}).evaluate({
        inferenceResults: [inferenceResult()],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(result.sessionDetails?.id).toBe(session.id);
  });

  it.each([
    ['an absent user id', undefined],
    ['an empty user id', ''],
  ])('falls back to the default user for %s', async (_name, userId) => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
      ...(userId === undefined
        ? {}
        : {sessionInput: {appName: APP_NAME, userId}}),
    });

    const [result] = await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult()],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(result.userId).toBe('test_user_id');
  });

  it('scores a conversation scenario without golden turns', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversationScenario: SCENARIO,
    });
    const inferences = [invocation(), invocation(), invocation()];

    const [result] = await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult({inferences})],
        evaluateConfig: {
          evalMetrics: [FAKE_SINGLE_SIDED_METRIC],
          parallelism: 1,
        },
      }),
    );

    expect(result.finalEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.overallEvalMetricResults?.[0].score).toBe(0.95);
    expect(FakeSingleSidedEvaluator.scenarios).toEqual([SCENARIO]);
    expect(result.evalMetricResultPerInvocation).toHaveLength(3);
    for (const entry of result.evalMetricResultPerInvocation) {
      expect(entry.expectedInvocation).toBeUndefined();
      expect(entry.evalMetricResults[0].score).toBe(0.995);
      expect(entry.evalMetricResults[0].evalStatus).toBe(EvalStatus.PASSED);
    }
  });

  it('reports a metric that failed as not evaluated', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversationScenario: SCENARIO,
    });
    const inferences = [invocation(), invocation(), invocation()];

    const [result] = await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult({inferences})],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(result.finalEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.overallEvalMetricResults?.[0].score).toBeUndefined();
    expect(result.overallEvalMetricResults?.[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.evalMetricResultPerInvocation).toHaveLength(3);
    for (const entry of result.evalMetricResultPerInvocation) {
      expect(entry.evalMetricResults[0].score).toBeUndefined();
      expect(entry.evalMetricResults[0].evalStatus).toBe(
        EvalStatus.NOT_EVALUATED,
      );
    }
  });

  it('scores the metrics that work when one of them fails', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversationScenario: SCENARIO,
    });

    const [result] = await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult()],
        evaluateConfig: {
          evalMetrics: [FAKE_METRIC, FAKE_SINGLE_SIDED_METRIC],
          parallelism: 1,
        },
      }),
    );

    expect(result.overallEvalMetricResults?.map((r) => r.evalStatus)).toEqual([
      EvalStatus.NOT_EVALUATED,
      EvalStatus.PASSED,
    ]);
    expect(result.finalEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('rejects a static case that has no expected conversation', async () => {
    evalSetsManager.setEvalCase({evalId: 'case1'});

    await expect(
      drain(
        createService().evaluate({
          inferenceResults: [inferenceResult()],
          evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
        }),
      ),
    ).rejects.toThrow(
      new InputValidationError(
        'A static eval case must provide an expected conversation.',
      ),
    );
  });

  it('rejects a static case whose turn count does not match', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });

    await expect(
      drain(
        createService().evaluate({
          inferenceResults: [
            inferenceResult({inferences: [invocation(), invocation()]}),
          ],
          evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
        }),
      ),
    ).rejects.toThrow(
      new InputValidationError(
        'Inferences should match conversations in eval case. Found 2 ' +
          'inferences and 1 conversations in eval case.',
      ),
    );
  });

  it('rejects a metric that scored fewer invocations than it was given', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });
    const registry = registryWithFakes();
    registry.registerEvaluator(
      FAKE_METRIC.metricName,
      () => new UnderreportingEvaluator(),
    );

    await expect(
      drain(
        createService({metricEvaluatorRegistry: registry}).evaluate({
          inferenceResults: [inferenceResult()],
          evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
        }),
      ),
    ).rejects.toThrow(
      new InputValidationError(
        'Eval metric should return results for each invocation. Found 0 ' +
          'results for 1 invocations.',
      ),
    );
  });

  it('copies the eval case rubrics onto the invocations it scores', async () => {
    const rubric = {rubricId: 'r1', rubricContent: {textProperty: 'Polite.'}};
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
      rubrics: [rubric],
    });
    const inferences = [invocation()];

    await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult({inferences})],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(inferences[0].rubrics).toEqual([rubric]);
  });

  it('copies each golden turn rubric onto the invocation in its place', async () => {
    const rubric = {rubricId: 'r2', rubricContent: {textProperty: 'Brief.'}};
    const expected = invocation();
    expected.rubrics = [rubric];
    evalSetsManager.setEvalCase({evalId: 'case1', conversation: [expected]});
    const inferences = [invocation()];

    await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult({inferences})],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(inferences[0].rubrics).toEqual([rubric]);
  });

  it('records the rubric scores a metric returned', async () => {
    const rubricScores = [{rubricId: 'r1', score: 1}];
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });
    const registry = registryWithFakes();
    registry.registerEvaluator(FAKE_METRIC.metricName, () => ({
      evaluateInvocations: (actualInvocations: Invocation[]) => ({
        overallScore: 1,
        overallEvalStatus: EvalStatus.PASSED,
        overallRubricScores: rubricScores,
        perInvocationResults: actualInvocations.map((actualInvocation) => ({
          actualInvocation,
          score: 1,
          evalStatus: EvalStatus.PASSED,
          rubricScores,
        })),
      }),
    }));

    const [result] = await drain(
      createService({metricEvaluatorRegistry: registry}).evaluate({
        inferenceResults: [inferenceResult()],
        evaluateConfig: {evalMetrics: [FAKE_METRIC], parallelism: 1},
      }),
    );

    expect(result.overallEvalMetricResults?.[0].details?.rubricScores).toEqual(
      rubricScores,
    );
    expect(
      result.evalMetricResultPerInvocation[0].evalMetricResults[0].details
        ?.rubricScores,
    ).toEqual(rubricScores);
  });

  it('degrades a metric with no registered evaluator', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });

    const [result] = await drain(
      createService().evaluate({
        inferenceResults: [inferenceResult()],
        evaluateConfig: {
          evalMetrics: [{metricName: 'unknown_metric', threshold: 0.5}],
          parallelism: 1,
        },
      }),
    );

    expect(result.finalEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.overallEvalMetricResults?.[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });
});

describe('generateFinalEvalStatus', () => {
  function metricResult(evalStatus: EvalStatus): EvalMetricResult {
    return {...FAKE_METRIC, evalStatus};
  }

  it('handles every eval status without throwing', () => {
    for (const status of [
      EvalStatus.PASSED,
      EvalStatus.FAILED,
      EvalStatus.NOT_EVALUATED,
    ]) {
      expect(() =>
        generateFinalEvalStatus([metricResult(status)]),
      ).not.toThrow();
    }
  });

  it('is not evaluated when there are no metric results', () => {
    expect(generateFinalEvalStatus([])).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('passes when every metric passed', () => {
    expect(
      generateFinalEvalStatus([
        metricResult(EvalStatus.PASSED),
        metricResult(EvalStatus.PASSED),
      ]),
    ).toBe(EvalStatus.PASSED);
  });

  it('fails when one metric failed', () => {
    expect(
      generateFinalEvalStatus([
        metricResult(EvalStatus.PASSED),
        metricResult(EvalStatus.FAILED),
        metricResult(EvalStatus.PASSED),
      ]),
    ).toBe(EvalStatus.FAILED);
  });

  it('is not evaluated when no metric was evaluated', () => {
    expect(
      generateFinalEvalStatus([
        metricResult(EvalStatus.NOT_EVALUATED),
        metricResult(EvalStatus.NOT_EVALUATED),
      ]),
    ).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('rejects a status the fold does not know', () => {
    const unknownStatus = 4 as EvalStatus;

    expect(() =>
      generateFinalEvalStatus([metricResult(unknownStatus)]),
    ).toThrow(new InputValidationError('Unknown eval status: 4.'));
  });
});

describe('LocalEvalService defaults', () => {
  it('uses the shipped registry when it is given none', async () => {
    evalSetsManager.setEvalCase({
      evalId: 'case1',
      conversation: [invocation()],
    });
    const service = createService({metricEvaluatorRegistry: undefined});

    const [result] = await drain(
      service.evaluate({
        inferenceResults: [inferenceResult()],
        evaluateConfig: {
          evalMetrics: [{metricName: 'response_match_score', threshold: 0.5}],
          parallelism: 1,
        },
      }),
    );

    expect(result.finalEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.overallEvalMetricResults?.[0].score).toBe(1);
  });

  it('runs with only a root agent and an eval sets manager', async () => {
    evalSetsManager.setEvalSet(EVAL_SET_ID, evalSetWith('case1'));
    const service = new LocalEvalService({
      rootAgent: scriptedAgent(),
      evalSetsManager,
    });

    const results = await drain(
      service.performInference({
        appName: APP_NAME,
        evalSetId: EVAL_SET_ID,
        inferenceConfig: {useLive: false},
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe(1);
    expect(results[0].sessionId).toMatch(
      new RegExp(`^${EVAL_SESSION_ID_PREFIX}`),
    );
    expect(emptyEvaluationResult().overallEvalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });
});
