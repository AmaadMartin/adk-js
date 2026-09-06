/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseEvalService,
  createEvaluateConfig,
  createInferenceConfig,
  EvalCaseResult,
  EvalStatus,
  EvaluateRequest,
  InferenceRequest,
  InferenceResult,
  InferenceStatus,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';

/**
 * An eval service that replays a fixed script, so a test can observe when each
 * result reaches the consumer.
 */
class ScriptedEvalService implements BaseEvalService {
  secondInferenceStarted = false;

  constructor(
    private readonly inferenceResults: InferenceResult[],
    private readonly caseResults: EvalCaseResult[] = [],
  ) {}

  async *performInference(
    inferenceRequest: InferenceRequest,
  ): AsyncGenerator<InferenceResult, void, void> {
    for (const [index, result] of this.inferenceResults.entries()) {
      if (index === 1) {
        this.secondInferenceStarted = true;
      }
      yield {...result, evalSetId: inferenceRequest.evalSetId};
    }
  }

  async *evaluate(
    evaluateRequest: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult, void, void> {
    for (const result of this.caseResults) {
      yield {
        ...result,
        overallEvalMetricResults:
          evaluateRequest.evaluateConfig.evalMetrics.map((metric) => ({
            ...metric,
            evalStatus: result.finalEvalStatus,
          })),
      };
    }
  }
}

function inferenceResult(
  evalCaseId: string,
  overrides: Partial<InferenceResult> = {},
): InferenceResult {
  return {
    appName: APP_NAME,
    evalSetId: EVAL_SET_ID,
    evalCaseId,
    status: InferenceStatus.SUCCESS,
    ...overrides,
  };
}

describe('createInferenceConfig', () => {
  it('applies the adk-python defaults', () => {
    const config = createInferenceConfig();

    expect(config).toEqual({
      parallelism: 4,
      useLive: false,
      liveTimeoutSeconds: 300,
    });
    expect('labels' in config).toBe(false);
  });

  it('keeps every supplied value, including a falsy one', () => {
    const config = createInferenceConfig({
      parallelism: 0,
      useLive: true,
      liveTimeoutSeconds: 5,
      labels: {team: 'core'},
    });

    expect(config).toEqual({
      parallelism: 0,
      useLive: true,
      liveTimeoutSeconds: 5,
      labels: {team: 'core'},
    });
  });
});

describe('createEvaluateConfig', () => {
  const evalMetrics = [{metricName: 'tool_trajectory_avg_score'}];

  it('defaults the parallelism and keeps the metrics', () => {
    const config = createEvaluateConfig({evalMetrics});

    expect(config).toEqual({evalMetrics, parallelism: 4});
  });

  it('keeps an explicit parallelism', () => {
    const config = createEvaluateConfig({evalMetrics, parallelism: 1});

    expect(config.parallelism).toBe(1);
  });
});

describe('InferenceStatus', () => {
  // Pinned against adk-python `base_eval_service.py`: the numeric values are
  // serialized, so they are part of the wire contract.
  it('matches the adk-python numeric values', () => {
    expect(InferenceStatus.UNKNOWN).toBe(0);
    expect(InferenceStatus.SUCCESS).toBe(1);
    expect(InferenceStatus.FAILURE).toBe(2);
  });
});

describe('BaseEvalService', () => {
  it('delivers each inference result before the next one is produced', async () => {
    const service = new ScriptedEvalService([
      inferenceResult('case-1'),
      inferenceResult('case-2'),
    ]);

    const results = service.performInference({
      appName: APP_NAME,
      evalSetId: EVAL_SET_ID,
      inferenceConfig: createInferenceConfig(),
    });

    const first = await results.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({evalCaseId: 'case-1'});
    expect(service.secondInferenceStarted).toBe(false);

    const second = await results.next();
    expect(second.value).toMatchObject({evalCaseId: 'case-2'});
    expect(service.secondInferenceStarted).toBe(true);
    expect((await results.next()).done).toBe(true);
  });

  it('reports a failed inference as a result and keeps going', async () => {
    const service = new ScriptedEvalService([
      inferenceResult('case-1', {
        status: InferenceStatus.FAILURE,
        errorMessage: 'model call timed out',
      }),
      inferenceResult('case-2'),
    ]);

    const collected: InferenceResult[] = [];
    for await (const result of service.performInference({
      appName: APP_NAME,
      evalSetId: EVAL_SET_ID,
      inferenceConfig: createInferenceConfig(),
    })) {
      collected.push(result);
    }

    expect(collected.map((result) => result.status)).toEqual([
      InferenceStatus.FAILURE,
      InferenceStatus.SUCCESS,
    ]);
    expect(collected[0].errorMessage).toBe('model call timed out');
  });

  it('scores the inference results it is given', async () => {
    const service = new ScriptedEvalService(
      [],
      [
        {
          evalId: 'case-1',
          finalEvalStatus: EvalStatus.PASSED,
          overallEvalMetricResults: [],
          evalMetricResultPerInvocation: [],
          sessionId: 'session-1',
        },
      ],
    );

    const collected: EvalCaseResult[] = [];
    for await (const result of service.evaluate({
      inferenceResults: [inferenceResult('case-1')],
      evaluateConfig: createEvaluateConfig({
        evalMetrics: [
          {metricName: 'response_match_score', criterion: {threshold: 0.8}},
        ],
      }),
    })) {
      collected.push(result);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].overallEvalMetricResults).toEqual([
      {
        metricName: 'response_match_score',
        criterion: {threshold: 0.8},
        evalStatus: EvalStatus.PASSED,
      },
    ]);
  });
});

describe('InferenceResult serialization', () => {
  it('round-trips through JSON with the adk-python key set', () => {
    const result = inferenceResult('case-1', {
      errorMessage: 'partial failure on turn 2',
      sessionId: 'session-1',
      inferences: [
        {
          invocationId: 'invocation-1',
          userContent: {role: 'user', parts: [{text: 'turn on the light'}]},
          finalResponse: {role: 'model', parts: [{text: 'done'}]},
          creationTimestamp: 1,
          intermediateData: {
            toolUses: [{name: 'set_light', args: {state: 'on'}}],
            toolResponses: [{name: 'set_light', response: {ok: true}}],
            intermediateResponses: [['light_agent', [{text: 'working'}]]],
          },
        },
      ],
    });

    const roundTripped: InferenceResult = JSON.parse(JSON.stringify(result));

    expect(Object.keys(roundTripped).sort()).toEqual([
      'appName',
      'errorMessage',
      'evalCaseId',
      'evalSetId',
      'inferences',
      'sessionId',
      'status',
    ]);
    expect(roundTripped).toEqual(result);
  });

  it('carries invocation events as the other intermediate data shape', () => {
    const result = inferenceResult('case-1', {
      inferences: [
        {
          userContent: {role: 'user', parts: [{text: 'turn on the light'}]},
          intermediateData: {
            invocationEvents: [
              {author: 'light_agent', content: {parts: [{text: 'working'}]}},
            ],
          },
        },
      ],
    });

    const roundTripped: InferenceResult = JSON.parse(JSON.stringify(result));
    const intermediateData = roundTripped.inferences?.[0].intermediateData;

    expect(intermediateData).toBeDefined();
    expect(intermediateData && 'invocationEvents' in intermediateData).toBe(
      true,
    );
    expect(roundTripped).toEqual(result);
  });
});
