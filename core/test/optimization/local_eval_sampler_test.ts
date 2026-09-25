/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/optimization/local_eval_sampler_test.py` @ main. Each
 * `describe` keeps the reference test's name.
 */

import type {
  EvalCaseResult,
  InferenceResult,
  InvocationEvents,
  LocalEvalSamplerConfig,
  LocalEvalServiceOptions,
} from '@google/adk';
import {
  CustomMetricEvaluator,
  EvalStatus,
  extractSingleInvocationInfo,
  extractToolCallData,
  getEvalMetricsFromConfig,
  InferenceStatus,
  LlmAgent,
  LocalEvalSampler,
  MetricEvaluatorRegistry,
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
  options: [] as LocalEvalServiceOptions[],
}));

vi.mock('../../src/evaluation/local_eval_service.js', () => ({
  LocalEvalService: class {
    performInference = evalService.performInference;
    evaluate = evalService.evaluate;

    constructor(options: LocalEvalServiceOptions) {
      evalService.options.push(options);
    }
  },
  createEvalSessionId: () => 'mocked_session_id',
}));

const EVAL_CONFIG = {criteria: {response_match_score: 0.8}};

/** An inference result the mocked eval service yields verbatim. */
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

/** Arranges the mocked eval service to yield these eval case results. */
function stubEvalService(evalResults: EvalCaseResult[]): void {
  evalService.performInference.mockImplementation(yields([INFERENCE_RESULT]));
  evalService.evaluate.mockImplementation(yields(evalResults));
}

async function createSampler(
  config: Partial<LocalEvalSamplerConfig> & {trainEvalSet: string},
): Promise<LocalEvalSampler> {
  const evalSetIds = [config.trainEvalSet];
  if (config.validationEvalSet) {
    evalSetIds.push(config.validationEvalSet);
  }
  return LocalEvalSampler.create({
    config: {evalConfig: EVAL_CONFIG, appName: TEST_APP, ...config},
    evalSetsManager: await createManagerWithSets(evalSetIds),
  });
}

const candidate = new LlmAgent({name: 'candidate'});

beforeEach(() => {
  vi.restoreAllMocks();
  evalService.options.length = 0;
  evalService.performInference.mockReset();
  evalService.evaluate.mockReset();
});

describe('test_log_eval_summary', () => {
  it('counts passed, failed and other eval cases', async () => {
    const statuses = [
      EvalStatus.PASSED,
      EvalStatus.PASSED,
      EvalStatus.PASSED,
      EvalStatus.FAILED,
      EvalStatus.FAILED,
      EvalStatus.NOT_EVALUATED,
    ];
    stubEvalService(
      statuses.map((status, index) =>
        createEvalCaseResult(`case_${index}`, status),
      ),
    );
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sampler = await createSampler({trainEvalSet: 'train_set'});

    await sampler.sampleAndScore({candidate});

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      'Evaluation summary: 3 PASSED, 2 FAILED, 1 OTHER',
    );
  });
});

describe('test_extract_tool_call_data', () => {
  it('reports nothing for empty invocation events', () => {
    expect(extractToolCallData({invocationEvents: []})).toEqual([]);
  });

  it('pairs every call with the response carrying its id', () => {
    const multiCallInvocationEvents: InvocationEvents = {
      invocationEvents: [
        {
          author: 'agent',
          content: {
            parts: [
              {functionCall: {id: 'call_1', name: 'tool_1', args: {a: 1}}},
              {functionCall: {id: 'call_2', name: 'tool_2', args: {b: 2}}},
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'tool_1',
                  response: {result_1: 'done'},
                },
              },
              {
                functionResponse: {
                  id: 'call_2',
                  name: 'tool_2',
                  response: {result_2: 'done'},
                },
              },
            ],
          },
        },
      ],
    };

    const result = extractToolCallData(multiCallInvocationEvents);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      name: 'tool_1',
      args: {a: 1},
      response: {result_1: 'done'},
    });
    expect(result).toContainEqual({
      name: 'tool_2',
      args: {b: 2},
      response: {result_2: 'done'},
    });
  });
});

describe('test_extract_single_invocation_info', () => {
  it('leaves thought parts out of both texts', () => {
    const invocation = createInvocation(
      {parts: [{text: 'user thought', thought: true}, {text: 'Hello agent!'}]},
      {parts: [{text: 'agent thought', thought: true}, {text: 'Hello user!'}]},
    );

    expect(extractSingleInvocationInfo(invocation)).toEqual({
      userPrompt: 'Hello agent!',
      agentResponse: 'Hello user!',
    });
  });
});

describe('test_local_eval_service_interface_init', () => {
  it('resolves both sets from the train set when only it is configured', async () => {
    const sampler = await createSampler({trainEvalSet: 'train_set'});

    expect(sampler.getTrainExampleIds()).toEqual([
      'train_set_1',
      'train_set_2',
    ]);
    expect(sampler.getValidationExampleIds()).toEqual([
      'train_set_1',
      'train_set_2',
    ]);
    expect(await evaluatedEvalSetId(sampler, Sampler.VALIDATION_SET)).toBe(
      'train_set',
    );
  });

  it('carries configured train case ids over to validation', async () => {
    const sampler = await createSampler({
      trainEvalSet: 'train_set',
      trainEvalCaseIds: ['t1'],
    });

    expect(sampler.getTrainExampleIds()).toEqual(['t1']);
    expect(sampler.getValidationExampleIds()).toEqual(['t1']);
  });

  it('looks up the validation set when one is configured', async () => {
    const sampler = await createSampler({
      trainEvalSet: 'train_set',
      validationEvalSet: 'val_set',
    });

    expect(sampler.getValidationExampleIds()).toEqual([
      'val_set_1',
      'val_set_2',
    ]);
    expect(await evaluatedEvalSetId(sampler, Sampler.VALIDATION_SET)).toBe(
      'val_set',
    );
  });

  it('honours validation case ids given without a validation set', async () => {
    const sampler = await createSampler({
      trainEvalSet: 'train_set',
      validationEvalCaseIds: ['v1'],
    });

    expect(sampler.getValidationExampleIds()).toEqual(['v1']);
    expect(await evaluatedEvalSetId(sampler, Sampler.VALIDATION_SET)).toBe(
      'train_set',
    );
  });

  it('takes all four values as configured', async () => {
    const sampler = await createSampler({
      trainEvalSet: 'train_set',
      trainEvalCaseIds: ['t1'],
      validationEvalSet: 'val_set',
      validationEvalCaseIds: ['v1'],
    });

    expect(sampler.getTrainExampleIds()).toEqual(['t1']);
    expect(sampler.getValidationExampleIds()).toEqual(['v1']);
    expect(await evaluatedEvalSetId(sampler, Sampler.VALIDATION_SET)).toBe(
      'val_set',
    );
  });
});

describe('test_init_registers_custom_metrics', () => {
  it('registers the custom metrics the eval config declares', async () => {
    stubEvalService([]);
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const callerRegistry = new MetricEvaluatorRegistry();
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: {
          criteria: {},
          customMetrics: {
            custom_metric_for_sampler_test: {
              codeConfig: {name: './metrics.js#score'},
            },
          },
        },
        appName: TEST_APP,
        trainEvalSet: 'train_set',
        trainEvalCaseIds: ['t1'],
      },
      evalSetsManager: await createManagerWithSets(['train_set']),
      metricEvaluatorRegistry: callerRegistry,
    });

    await sampler.sampleAndScore({candidate, exampleSet: Sampler.TRAIN_SET});

    const registry = evalService.options.at(-1)?.metricEvaluatorRegistry;
    expect(registry).toBeDefined();
    expect(
      registry?.getEvaluator({
        metricName: 'custom_metric_for_sampler_test',
        threshold: 0.5,
      }),
    ).toBeInstanceOf(CustomMetricEvaluator);
  });

  it('leaves the registry the caller passed untouched', async () => {
    stubEvalService([]);
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const callerRegistry = new MetricEvaluatorRegistry();
    await LocalEvalSampler.create({
      config: {
        evalConfig: {
          criteria: {},
          customMetrics: {
            leaked_metric: {codeConfig: {name: './metrics.js#score'}},
          },
        },
        appName: TEST_APP,
        trainEvalSet: 'train_set',
        trainEvalCaseIds: ['t1'],
      },
      evalSetsManager: await createManagerWithSets(['train_set']),
      metricEvaluatorRegistry: callerRegistry,
    });

    expect(() =>
      callerRegistry.getEvaluator({metricName: 'leaked_metric'}),
    ).toThrowError(NotFoundError);
  });
});

describe('test_evaluate_agent', () => {
  it('passes the inference request and the config metrics through', async () => {
    stubEvalService([createEvalCaseResult('t1', EvalStatus.PASSED)]);
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sampler = await createSampler({
      trainEvalSet: 'train_set',
      trainEvalCaseIds: ['t1'],
    });

    const result = await sampler.sampleAndScore({
      candidate,
      exampleSet: Sampler.TRAIN_SET,
    });

    expect(evalService.performInference).toHaveBeenCalledTimes(1);
    expect(evalService.performInference).toHaveBeenCalledWith({
      appName: TEST_APP,
      evalSetId: 'train_set',
      evalCaseIds: ['t1'],
      inferenceConfig: {useLive: false},
    });
    expect(evalService.evaluate).toHaveBeenCalledTimes(1);
    expect(evalService.evaluate).toHaveBeenCalledWith({
      inferenceResults: [INFERENCE_RESULT],
      evaluateConfig: {evalMetrics: getEvalMetricsFromConfig(EVAL_CONFIG)},
    });
    expect(result.scores).toEqual({t1: 1.0});
  });
});

describe('test_extract_eval_data', () => {
  it('rounds scores, names statuses and shares the scenario object', async () => {
    const conversationScenario = {
      startingPrompt: 'Start here.',
      conversationPlan: 'Complete the task.',
    };
    const evalCase = {evalId: 't1', conversationScenario};
    const actualInvocation = createInvocation(
      {parts: [{text: 'actual prompt'}]},
      {parts: [{text: 'actual answer'}]},
    );
    const expectedInvocation = createInvocation(
      {parts: [{text: 'expected prompt'}]},
      {parts: [{text: 'expected answer'}]},
    );
    stubEvalService([
      createEvalCaseResult('t1', EvalStatus.PASSED, [
        createPerInvocationResult(
          actualInvocation,
          [
            createMetricResult('test_metric', EvalStatus.PASSED, 0.854),
            createMetricResult(
              'not_evaluated_metric',
              EvalStatus.NOT_EVALUATED,
            ),
          ],
          expectedInvocation,
        ),
      ]),
    ]);
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: EVAL_CONFIG,
        appName: TEST_APP,
        trainEvalSet: 'train_set',
        trainEvalCaseIds: ['t1'],
      },
      evalSetsManager: new ReadOnlyEvalSetsManager(
        new Map(),
        new Map([[`${TEST_APP}/train_set/t1`, evalCase]]),
      ),
    });

    const result = await sampler.sampleAndScore({
      candidate,
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });

    const captured = result.data?.['t1'];
    expect(captured).toBeDefined();
    expect(captured?.['conversationScenario']).toBe(conversationScenario);
    expect(captured?.['invocations']).toEqual([
      {
        actualInvocation: {
          userPrompt: 'actual prompt',
          agentResponse: 'actual answer',
        },
        expectedInvocation: {
          userPrompt: 'expected prompt',
          agentResponse: 'expected answer',
        },
        evalMetricResults: [
          {metricName: 'test_metric', score: 0.85, evalStatus: 'PASSED'},
          {
            metricName: 'not_evaluated_metric',
            score: undefined,
            evalStatus: 'NOT_EVALUATED',
          },
        ],
      },
    ]);
  });
});

describe('test_sample_and_score', () => {
  it('scores a passed case 1 and a failed case 0, and captures data', async () => {
    stubEvalService([
      createEvalCaseResult('t1', EvalStatus.PASSED),
      createEvalCaseResult('t2', EvalStatus.FAILED),
    ]);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: EVAL_CONFIG,
        appName: TEST_APP,
        trainEvalSet: 'train_set',
        trainEvalCaseIds: ['t1', 't2'],
      },
      evalSetsManager: new ReadOnlyEvalSetsManager(
        new Map(),
        new Map([[`${TEST_APP}/train_set/t1`, createEvalCase('t1')]]),
      ),
    });

    const result = await sampler.sampleAndScore({
      candidate,
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });

    expect(result.scores).toEqual({t1: 1.0, t2: 0.0});
    expect(result.data).toEqual({t1: {invocations: []}, t2: {invocations: []}});
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(evalService.performInference).toHaveBeenCalledWith(
      expect.objectContaining({evalSetId: 'train_set'}),
    );
  });
});

/** Runs the sampler once and reports the eval set id it evaluated. */
async function evaluatedEvalSetId(
  sampler: LocalEvalSampler,
  exampleSet: 'train' | 'validation',
): Promise<string> {
  stubEvalService([]);
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  await sampler.sampleAndScore({candidate, exampleSet});
  const request = evalService.performInference.mock.calls.at(-1)?.[0];
  expect(request).toBeDefined();
  return (request as {evalSetId: string}).evalSetId;
}
