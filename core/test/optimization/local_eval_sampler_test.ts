/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `tests/unittests/optimization/local_eval_sampler_test.py` in
 * `google/adk-python` at commit `0b75a66d`. Every reference test name is kept
 * verbatim as the `it(...)` string.
 *
 * Two deviations from the reference:
 *
 * - `_log_eval_summary` stays module-private here, so `test_log_eval_summary`
 *   drives it through `sampleAndScore` and spies on the logger.
 * - `test_init_registers_custom_metrics` cannot assert what it asserts in
 *   Python: adk-js has no custom-metric evaluator, so no metric is registered
 *   from the eval config. It asserts instead that a caller-supplied metric
 *   evaluator registry is the one that scores the run.
 */

import {
  DEFAULT_EVAL_CONFIG,
  EvalCaseResult,
  EvalConfig,
  EvalStatus,
  EvaluationResult,
  Evaluator,
  extractSingleInvocationInfo,
  extractToolCallData,
  getEvalMetricsFromConfig,
  InferenceResult,
  Invocation,
  InvocationEvents,
  LlmAgent,
  LocalEvalSampler,
  LocalEvalSamplerConfig,
  MetricEvaluatorRegistry,
  Sampler,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';
import {
  APP_NAME,
  createEvalCase,
  createEvalCaseResult,
  createEvalSetsManager,
  createInferenceResult,
  ScriptedLlm,
  stubEvalService,
} from './local_eval_sampler_test_utils.js';

const CANDIDATE = new LlmAgent({name: 'candidate'});

/** The sets `test_local_eval_service_interface_init` resolves ids from. */
const SEEDED_SETS = {
  'train_set': [createEvalCase('train_set_1'), createEvalCase('train_set_2')],
  'val_set': [createEvalCase('val_set_1'), createEvalCase('val_set_2')],
};

async function createSampler(
  configOverrides: Partial<LocalEvalSamplerConfig>,
  evalConfig: EvalConfig = DEFAULT_EVAL_CONFIG,
): Promise<LocalEvalSampler> {
  return LocalEvalSampler.create({
    config: {
      evalConfig,
      appName: APP_NAME,
      trainEvalSet: 'train_set',
      ...configOverrides,
    },
    evalSetsManager: await createEvalSetsManager(SEEDED_SETS),
  });
}

describe('LocalEvalSampler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_log_eval_summary', async () => {
    const statuses = [
      EvalStatus.PASSED,
      EvalStatus.PASSED,
      EvalStatus.PASSED,
      EvalStatus.FAILED,
      EvalStatus.FAILED,
      EvalStatus.NOT_EVALUATED,
    ];
    const evalResults = statuses.map((status, index) =>
      createEvalCaseResult(`t${index}`, status),
    );
    stubEvalService([], evalResults);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const sampler = await createSampler({trainEvalCaseIds: ['t1']});

    await sampler.sampleAndScore({candidate: CANDIDATE});

    expect(debugSpy).toHaveBeenCalledExactlyOnceWith(
      'Evaluation summary: 3 PASSED, 2 FAILED, 1 OTHER',
    );
  });

  it('test_extract_tool_call_data', () => {
    expect(extractToolCallData({invocationEvents: []})).toEqual([]);

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

  it('test_extract_single_invocation_info', () => {
    const invocation: Invocation = {
      userContent: {
        parts: [{text: 'user thought', thought: true}, {text: 'Hello agent!'}],
      },
      finalResponse: {
        parts: [{text: 'agent thought', thought: true}, {text: 'Hello user!'}],
      },
    };

    const result = extractSingleInvocationInfo(invocation);

    expect(result).toEqual({
      userPrompt: 'Hello agent!',
      agentResponse: 'Hello user!',
    });
  });

  describe('test_local_eval_service_interface_init', () => {
    const cases: Array<{
      name: string;
      config: Partial<LocalEvalSamplerConfig>;
      trainIds: string[];
      validationIds: string[];
      validationSet: string;
    }> = [
      {
        name: 'train set only',
        config: {},
        trainIds: ['train_set_1', 'train_set_2'],
        validationIds: ['train_set_1', 'train_set_2'],
        validationSet: 'train_set',
      },
      {
        name: 'explicit train case ids',
        config: {trainEvalCaseIds: ['t1']},
        trainIds: ['t1'],
        validationIds: ['t1'],
        validationSet: 'train_set',
      },
      {
        name: 'separate validation set',
        config: {validationEvalSet: 'val_set'},
        trainIds: ['train_set_1', 'train_set_2'],
        validationIds: ['val_set_1', 'val_set_2'],
        validationSet: 'val_set',
      },
      {
        name: 'explicit validation case ids',
        config: {validationEvalCaseIds: ['v1']},
        trainIds: ['train_set_1', 'train_set_2'],
        validationIds: ['v1'],
        validationSet: 'train_set',
      },
      {
        name: 'every id stated',
        config: {
          trainEvalCaseIds: ['t1'],
          validationEvalSet: 'val_set',
          validationEvalCaseIds: ['v1'],
        },
        trainIds: ['t1'],
        validationSet: 'val_set',
        validationIds: ['v1'],
      },
    ];

    it.each(cases)(
      '$name',
      async ({config, trainIds, validationIds, validationSet}) => {
        const stub = stubEvalService([], []);
        const sampler = await createSampler(config);

        expect(sampler.getTrainExampleIds()).toEqual(trainIds);
        expect(sampler.getValidationExampleIds()).toEqual(validationIds);

        await sampler.sampleAndScore({candidate: CANDIDATE});

        expect(stub.inferenceRequests[0].evalSetId).toBe(validationSet);
        expect(stub.inferenceRequests[0].evalCaseIds).toEqual(validationIds);
      },
    );
  });

  it('test_init_registers_custom_metrics', async () => {
    const metricName = 'custom_metric_for_sampler_test';
    const registry = new MetricEvaluatorRegistry();
    registry.registerEvaluator(metricName, () => new ConstantEvaluator(0.9));
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: {criteria: {[metricName]: 0.5}},
        appName: APP_NAME,
        trainEvalSet: 'train_set',
        trainEvalCaseIds: ['train_set_1'],
      },
      evalSetsManager: await createEvalSetsManager(SEEDED_SETS),
      metricEvaluatorRegistry: registry,
    });

    const result = await sampler.sampleAndScore({
      candidate: new LlmAgent({
        name: 'candidate',
        model: new ScriptedLlm('hi'),
      }),
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });

    expect(result.scores).toEqual({'train_set_1': 1.0});
    expect(result.data?.['train_set_1']).toMatchObject({
      invocations: [
        {
          evalMetricResults: [{metricName, score: 0.9, evalStatus: 'PASSED'}],
        },
      ],
    });
  });

  it('test_evaluate_agent', async () => {
    const inferenceResult = createInferenceResult('train_set', 't1');
    const evalResult = createEvalCaseResult('t1', EvalStatus.PASSED);
    const stub = stubEvalService([inferenceResult], [evalResult]);
    const sampler = await createSampler({trainEvalCaseIds: ['t1']});

    const result = await sampler.sampleAndScore({
      candidate: CANDIDATE,
      exampleSet: Sampler.TRAIN_SET,
    });

    expect(stub.inferenceRequests).toEqual([
      {
        appName: APP_NAME,
        evalSetId: 'train_set',
        evalCaseIds: ['t1'],
        inferenceConfig: {useLive: false},
      },
    ]);
    expect(stub.evaluateRequests).toEqual([
      {
        inferenceResults: [inferenceResult],
        evaluateConfig: {
          evalMetrics: getEvalMetricsFromConfig(DEFAULT_EVAL_CONFIG),
        },
      },
    ]);
    expect(result.scores).toEqual({t1: 1.0});
  });

  it('test_extract_eval_data', async () => {
    const scenario = {
      startingPrompt: 'Start here.',
      conversationPlan: 'Complete the task.',
    };
    const evalSetsManager = await createEvalSetsManager({
      'train_set': [
        {evalId: 't1', conversationScenario: scenario},
        createEvalCase('t2'),
      ],
    });
    const actualInvocation: Invocation = {
      userContent: {parts: [{text: 'ask'}]},
      finalResponse: {parts: [{text: 'answer'}]},
    };
    const expectedInvocation: Invocation = {
      userContent: {parts: [{text: 'ask'}]},
      finalResponse: {parts: [{text: 'reference'}]},
    };
    const evalResult: EvalCaseResult = createEvalCaseResult(
      't1',
      EvalStatus.PASSED,
      {
        evalMetricResultPerInvocation: [
          {
            actualInvocation,
            expectedInvocation,
            evalMetricResults: [
              {
                metricName: 'test_metric',
                threshold: 0.5,
                score: 0.854,
                evalStatus: EvalStatus.PASSED,
              },
              {
                metricName: 'not_evaluated_metric',
                threshold: 0.5,
                evalStatus: EvalStatus.NOT_EVALUATED,
              },
            ],
          },
        ],
      },
    );
    stubEvalService([], [evalResult]);
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: DEFAULT_EVAL_CONFIG,
        appName: APP_NAME,
        trainEvalSet: 'train_set',
        trainEvalCaseIds: ['t1'],
      },
      evalSetsManager,
    });

    const result = await sampler.sampleAndScore({
      candidate: CANDIDATE,
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });

    const evalData = result.data ?? expect.fail('data was not captured');
    expect(evalData['t1']['conversationScenario']).toBe(scenario);
    expect(evalData['t1']['invocations']).toEqual([
      {
        actualInvocation: {userPrompt: 'ask', agentResponse: 'answer'},
        expectedInvocation: {userPrompt: 'ask', agentResponse: 'reference'},
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

  it('test_sample_and_score', async () => {
    const inferenceResults: InferenceResult[] = [
      createInferenceResult('train_set', 't1'),
      createInferenceResult('train_set', 't2'),
    ];
    stubEvalService(inferenceResults, [
      createEvalCaseResult('t1', EvalStatus.PASSED),
      createEvalCaseResult('t2', EvalStatus.FAILED),
    ]);
    const evalSetsManager = await createEvalSetsManager({
      'train_set': [createEvalCase('t1'), createEvalCase('t2')],
    });
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: DEFAULT_EVAL_CONFIG,
        appName: APP_NAME,
        trainEvalSet: 'train_set',
        trainEvalCaseIds: ['t1', 't2'],
      },
      evalSetsManager,
    });

    const result = await sampler.sampleAndScore({
      candidate: CANDIDATE,
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });

    expect(result.scores).toEqual({t1: 1.0, t2: 0.0});
    expect(result.data).toEqual({
      t1: {invocations: []},
      t2: {invocations: []},
    });
  });
});

/** Scores every invocation the same, so a run's score is known in advance. */
class ConstantEvaluator implements Evaluator {
  constructor(private readonly score: number) {}

  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    return {
      overallScore: this.score,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: actualInvocations.map((actualInvocation) => ({
        actualInvocation,
        score: this.score,
        evalStatus: EvalStatus.PASSED,
      })),
    };
  }
}
