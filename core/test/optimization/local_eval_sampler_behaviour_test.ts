/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of `LocalEvalSampler` that the adk-python reference tests do not
 * cover: the error paths, the defaults of `sampleAndScore`, and the shapes the
 * captured data takes when a field is missing.
 */

import type {EvalCaseResult, InferenceResult} from '@google/adk';
import {
  EvalStatus,
  extractSingleInvocationInfo,
  extractToolCallData,
  InferenceStatus,
  LlmAgent,
  LocalEvalSampler,
  NotFoundError,
  Sampler,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';
import {
  createEvalCase,
  createEvalCaseResult,
  createInvocation,
  createManagerWithSets,
  createMetricResult,
  createPerInvocationResult,
  ReadOnlyEvalSetsManager,
  TEST_APP,
} from './local_eval_sampler_test_utils.js';

const evalService = vi.hoisted(() => ({
  performInference: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock('../../src/evaluation/local_eval_service.js', () => ({
  LocalEvalService: class {
    performInference = evalService.performInference;
    evaluate = evalService.evaluate;
  },
  createEvalSessionId: () => 'mocked_session_id',
}));

const EVAL_CONFIG = {criteria: {response_match_score: 0.8}};

const INFERENCE_RESULT: InferenceResult = {
  appName: TEST_APP,
  evalSetId: 'train_set',
  evalCaseId: 't1',
  status: InferenceStatus.SUCCESS,
};

function yields<T>(items: T[]) {
  return async function* (): AsyncGenerator<T> {
    for (const item of items) {
      yield item;
    }
  };
}

function stubEvalService(evalResults: EvalCaseResult[]): void {
  evalService.performInference.mockImplementation(yields([INFERENCE_RESULT]));
  evalService.evaluate.mockImplementation(yields(evalResults));
}

const candidate = new LlmAgent({name: 'candidate'});

beforeEach(() => {
  vi.restoreAllMocks();
  evalService.performInference.mockReset();
  evalService.evaluate.mockReset();
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

describe('LocalEvalSampler.create', () => {
  it('reports a missing train eval set by name', async () => {
    const evalSetsManager = await createManagerWithSets([]);

    await expect(
      LocalEvalSampler.create({
        config: {
          evalConfig: EVAL_CONFIG,
          appName: TEST_APP,
          trainEvalSet: 'missing_set',
        },
        evalSetsManager,
      }),
    ).rejects.toThrowError(
      new NotFoundError(
        'Eval set `missing_set` does not exist for app `test_app`.',
      ),
    );
  });

  it('reports a missing validation eval set by name', async () => {
    const evalSetsManager = await createManagerWithSets(['train_set']);

    await expect(
      LocalEvalSampler.create({
        config: {
          evalConfig: EVAL_CONFIG,
          appName: TEST_APP,
          trainEvalSet: 'train_set',
          validationEvalSet: 'missing_val_set',
        },
        evalSetsManager,
      }),
    ).rejects.toThrowError(
      new NotFoundError(
        'Eval set `missing_val_set` does not exist for app `test_app`.',
      ),
    );
  });
});

describe('LocalEvalSampler.sampleAndScore', () => {
  async function createSampler(): Promise<LocalEvalSampler> {
    return LocalEvalSampler.create({
      config: {
        evalConfig: EVAL_CONFIG,
        appName: TEST_APP,
        trainEvalSet: 'train_set',
        validationEvalSet: 'val_set',
      },
      evalSetsManager: await createManagerWithSets(['train_set', 'val_set']),
    });
  }

  it('scores the validation set when no example set is named', async () => {
    stubEvalService([]);
    const sampler = await createSampler();

    await sampler.sampleAndScore({candidate});

    expect(evalService.performInference).toHaveBeenCalledWith({
      appName: TEST_APP,
      evalSetId: 'val_set',
      evalCaseIds: ['val_set_1', 'val_set_2'],
      inferenceConfig: {useLive: false},
    });
  });

  it('uses an explicit batch in place of the resolved ids', async () => {
    stubEvalService([]);
    const sampler = await createSampler();

    await sampler.sampleAndScore({
      candidate,
      exampleSet: Sampler.TRAIN_SET,
      batch: ['only_this_one'],
    });

    expect(evalService.performInference).toHaveBeenCalledWith(
      expect.objectContaining({
        evalSetId: 'train_set',
        evalCaseIds: ['only_this_one'],
      }),
    );
  });

  it('omits the data key when full eval data is not requested', async () => {
    stubEvalService([createEvalCaseResult('t1', EvalStatus.PASSED)]);
    const sampler = await createSampler();

    const omitted = await sampler.sampleAndScore({candidate});
    const explicitlyFalse = await sampler.sampleAndScore({
      candidate,
      captureFullEvalData: false,
    });

    expect('data' in omitted).toBe(false);
    expect('data' in explicitlyFalse).toBe(false);
  });

  it('scores a not-evaluated case the same as a failure', async () => {
    stubEvalService([createEvalCaseResult('t1', EvalStatus.NOT_EVALUATED)]);
    const sampler = await createSampler();

    const result = await sampler.sampleAndScore({candidate});

    expect(result.scores).toEqual({t1: 0.0});
  });

  it('scores only the cases the eval service yielded', async () => {
    stubEvalService([createEvalCaseResult('val_set_1', EvalStatus.PASSED)]);
    const sampler = await createSampler();

    const result = await sampler.sampleAndScore({candidate});

    expect(result.scores).toEqual({val_set_1: 1.0});
  });

  it('logs no OTHER count when every case passed or failed', async () => {
    stubEvalService([
      createEvalCaseResult('t1', EvalStatus.PASSED),
      createEvalCaseResult('t2', EvalStatus.FAILED),
    ]);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sampler = await createSampler();

    await sampler.sampleAndScore({candidate});

    expect(infoSpy).toHaveBeenCalledWith(
      'Evaluation summary: 1 PASSED, 1 FAILED',
    );
  });
});

describe('LocalEvalSampler captured data', () => {
  async function captureOne(
    evalResult: EvalCaseResult,
    evalCases: Map<string, ReturnType<typeof createEvalCase>> = new Map(),
  ) {
    stubEvalService([evalResult]);
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: EVAL_CONFIG,
        appName: TEST_APP,
        trainEvalSet: 'train_set',
        trainEvalCaseIds: [evalResult.evalId],
      },
      evalSetsManager: new ReadOnlyEvalSetsManager(new Map(), evalCases),
    });
    const result = await sampler.sampleAndScore({
      candidate,
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });
    return result.data?.[evalResult.evalId];
  }

  it('captures invocations for an eval case the manager does not have', async () => {
    const captured = await captureOne(
      createEvalCaseResult('t1', EvalStatus.PASSED, [
        createPerInvocationResult(
          createInvocation({parts: [{text: 'hi'}]}, {parts: [{text: 'hello'}]}),
          [createMetricResult('response_match_score', EvalStatus.PASSED, 1)],
        ),
      ]),
    );

    expect(captured).toBeDefined();
    expect('conversationScenario' in (captured ?? {})).toBe(false);
    expect(captured?.['invocations']).toHaveLength(1);
  });

  it('omits expectedInvocation when the result carries none', async () => {
    const captured = await captureOne(
      createEvalCaseResult('t1', EvalStatus.FAILED, [
        createPerInvocationResult(createInvocation({parts: [{text: 'hi'}]}), [
          createMetricResult('response_match_score', EvalStatus.FAILED, 0),
        ]),
      ]),
    );

    const invocations = captured?.['invocations'] as Array<
      Record<string, unknown>
    >;
    expect('expectedInvocation' in invocations[0]).toBe(false);
  });

  it('omits the scenario for an eval case that has none', async () => {
    const captured = await captureOne(
      createEvalCaseResult('t1', EvalStatus.PASSED),
      new Map([[`${TEST_APP}/train_set/t1`, createEvalCase('t1')]]),
    );

    expect(captured).toEqual({invocations: []});
  });
});

describe('extractToolCallData', () => {
  it('omits the response when no response carried the call id', () => {
    const result = extractToolCallData({
      invocationEvents: [
        {
          author: 'agent',
          content: {
            parts: [
              {functionCall: {id: 'call_1', name: 'tool_1', args: {a: 1}}},
              {
                functionResponse: {
                  id: 'other_call',
                  name: 'tool_1',
                  response: {result: 'done'},
                },
              },
            ],
          },
        },
      ],
    });

    expect(result).toEqual([
      {name: 'tool_1', args: {a: 1}, response: undefined},
    ]);
  });

  it('reports nothing when there is no intermediate data', () => {
    expect(extractToolCallData()).toEqual([]);
  });
});

describe('extractSingleInvocationInfo', () => {
  it('returns empty texts and no tool calls for an empty invocation', () => {
    const info = extractSingleInvocationInfo(createInvocation({}));

    expect(info).toEqual({userPrompt: '', agentResponse: ''});
    expect('toolCalls' in info).toBe(false);
  });

  it('captures tool calls when the invocation recorded intermediate data', () => {
    const info = extractSingleInvocationInfo(
      createInvocation({parts: [{text: 'hi'}]}, undefined, {
        toolUses: [{id: 'call_1', name: 'tool_1', args: {a: 1}}],
        toolResponses: [{id: 'call_1', name: 'tool_1', response: {ok: true}}],
        intermediateResponses: [],
      }),
    );

    expect(info.toolCalls).toEqual([
      {name: 'tool_1', args: {a: 1}, response: {ok: true}},
    ]);
  });
});
