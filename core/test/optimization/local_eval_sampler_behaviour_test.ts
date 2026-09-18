/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour the ported reference tests in `local_eval_sampler_test.ts` do not
 * reach: the failure path of `create`, the option defaults, and the shapes
 * `extractEvalData` produces from sparse input.
 */

import {
  DEFAULT_EVAL_CONFIG,
  EvalStatus,
  extractSingleInvocationInfo,
  extractToolCallData,
  InvocationEvents,
  isSampler,
  LlmAgent,
  LocalEvalSampler,
  LocalEvalSamplerConfig,
  NotFoundError,
  Sampler,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';
import {
  APP_NAME,
  createEvalCase,
  createEvalCaseResult,
  createEvalSetsManager,
  stubEvalService,
} from './local_eval_sampler_test_utils.js';

const CANDIDATE = new LlmAgent({name: 'candidate'});

const SEEDED_SETS = {
  'train_set': [createEvalCase('t1'), createEvalCase('t2')],
  'val_set': [createEvalCase('v1')],
};

async function createSampler(
  configOverrides: Partial<LocalEvalSamplerConfig> = {},
): Promise<LocalEvalSampler> {
  return LocalEvalSampler.create({
    config: {
      evalConfig: DEFAULT_EVAL_CONFIG,
      appName: APP_NAME,
      trainEvalSet: 'train_set',
      ...configOverrides,
    },
    evalSetsManager: await createEvalSetsManager(SEEDED_SETS),
  });
}

describe('LocalEvalSampler.create', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects when the train eval set does not exist', async () => {
    const evalSetsManager = await createEvalSetsManager(SEEDED_SETS);

    const create = LocalEvalSampler.create({
      config: {
        evalConfig: DEFAULT_EVAL_CONFIG,
        appName: APP_NAME,
        trainEvalSet: 'missing_set',
      },
      evalSetsManager,
    });

    await expect(create).rejects.toThrowError(NotFoundError);
    await expect(create).rejects.toThrowError(
      'Eval set `missing_set` does not exist for app `test_app`.',
    );
  });

  it('rejects when the validation eval set does not exist', async () => {
    const evalSetsManager = await createEvalSetsManager(SEEDED_SETS);

    const create = LocalEvalSampler.create({
      config: {
        evalConfig: DEFAULT_EVAL_CONFIG,
        appName: APP_NAME,
        trainEvalSet: 'train_set',
        validationEvalSet: 'missing_set',
      },
      evalSetsManager,
    });

    await expect(create).rejects.toThrowError(
      'Eval set `missing_set` does not exist for app `test_app`.',
    );
  });

  it('reads the validation ids from the validation set, not the train set', async () => {
    const sampler = await createSampler({validationEvalSet: 'val_set'});

    expect(sampler.getTrainExampleIds()).toEqual(['t1', 't2']);
    expect(sampler.getValidationExampleIds()).toEqual(['v1']);
  });

  it('is recognised by the Sampler type guard', async () => {
    expect(isSampler(await createSampler())).toBe(true);
  });
});

describe('LocalEvalSampler.sampleAndScore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits the data when the caller does not ask for it', async () => {
    stubEvalService([], [createEvalCaseResult('t1', EvalStatus.PASSED)]);
    const sampler = await createSampler();

    const result = await sampler.sampleAndScore({candidate: CANDIDATE});

    expect(result.scores).toEqual({t1: 1.0});
    expect(result.data).toBeUndefined();
  });

  it('evaluates the batch the caller gives instead of the whole set', async () => {
    const stub = stubEvalService([], []);
    const sampler = await createSampler();

    await sampler.sampleAndScore({candidate: CANDIDATE, batch: ['t2']});

    expect(stub.inferenceRequests[0].evalCaseIds).toEqual(['t2']);
  });

  it('evaluates the validation set when no example set is named', async () => {
    const stub = stubEvalService([], []);
    const sampler = await createSampler({validationEvalSet: 'val_set'});

    await sampler.sampleAndScore({candidate: CANDIDATE});

    expect(stub.inferenceRequests[0].evalSetId).toBe('val_set');
    expect(stub.inferenceRequests[0].evalCaseIds).toEqual(['v1']);
  });

  it('scores a case that was never evaluated as zero', async () => {
    stubEvalService([], [createEvalCaseResult('t1', EvalStatus.NOT_EVALUATED)]);
    const sampler = await createSampler();

    const result = await sampler.sampleAndScore({candidate: CANDIDATE});

    expect(result.scores).toEqual({t1: 0.0});
  });

  it('omits the OTHER count when every case passed or failed', async () => {
    stubEvalService(
      [],
      [
        createEvalCaseResult('t1', EvalStatus.PASSED),
        createEvalCaseResult('t2', EvalStatus.FAILED),
      ],
    );
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const sampler = await createSampler();

    await sampler.sampleAndScore({candidate: CANDIDATE});

    expect(debugSpy).toHaveBeenCalledExactlyOnceWith(
      'Evaluation summary: 1 PASSED, 1 FAILED',
    );
  });

  it('omits the conversation scenario for a case that has none', async () => {
    stubEvalService([], [createEvalCaseResult('t1', EvalStatus.PASSED)]);
    const sampler = await createSampler();

    const result = await sampler.sampleAndScore({
      candidate: CANDIDATE,
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });

    expect(result.data?.['t1']).toEqual({invocations: []});
  });

  it('captures no invocations for a case the eval service scored none for', async () => {
    stubEvalService([], [createEvalCaseResult('unknown', EvalStatus.FAILED)]);
    const sampler = await createSampler();

    const result = await sampler.sampleAndScore({
      candidate: CANDIDATE,
      captureFullEvalData: true,
    });

    expect(result.data).toEqual({unknown: {invocations: []}});
  });
});

describe('extractToolCallData', () => {
  it('omits the response of a call nothing answered', () => {
    const invocationEvents: InvocationEvents = {
      invocationEvents: [
        {
          author: 'agent',
          content: {
            parts: [
              {functionCall: {id: 'call_1', name: 'tool_1', args: {a: 1}}},
            ],
          },
        },
      ],
    };

    const result = extractToolCallData(invocationEvents);

    expect(result).toEqual([{name: 'tool_1', args: {a: 1}}]);
    expect(result[0]).not.toHaveProperty('response');
  });

  it('reports no tool calls when there is no intermediate data', () => {
    expect(extractToolCallData()).toEqual([]);
  });
});

describe('extractSingleInvocationInfo', () => {
  it('omits the tool calls when the invocation recorded none', () => {
    const result = extractSingleInvocationInfo({
      userContent: {parts: [{text: 'ask'}]},
    });

    expect(result).toEqual({userPrompt: 'ask', agentResponse: ''});
    expect(result).not.toHaveProperty('toolCalls');
  });

  it('reports the tool calls when the invocation recorded them', () => {
    const result = extractSingleInvocationInfo({
      userContent: {parts: [{text: 'ask'}]},
      intermediateData: {
        toolUses: [{id: 'call_1', name: 'tool_1', args: {a: 1}}],
        toolResponses: [{id: 'call_1', name: 'tool_1', response: {ok: true}}],
        intermediateResponses: [],
      },
    });

    expect(result.toolCalls).toEqual([
      {name: 'tool_1', args: {a: 1}, response: {ok: true}},
    ]);
  });
});
