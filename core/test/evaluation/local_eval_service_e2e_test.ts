/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  EvalCase,
  EvalCaseResult,
  EvalSet,
  EvalSetsManager,
  EvalStatus,
  EvaluationResult,
  Evaluator,
  EvaluatorConstructorOptions,
  InferenceResult,
  InferenceStatus,
  Invocation,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LocalEvalService,
  MetricEvaluatorRegistry,
  MetricInfo,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A deterministic model that replies with a fixed text response. No network. */
class FixedResponseModel extends BaseLlm {
  constructor() {
    super({model: 'fixed-response-model'});
  }

  override async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: 'Hello from the agent.'}]}};
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not used by non-live inference.');
  }
}

const TRIVIAL_METRIC_INFO: MetricInfo = {
  metricName: 'e2e_trivial_metric',
  description: 'A trivial metric that always passes.',
  metricValueInfo: {
    interval: {
      minValue: 0.0,
      openAtMin: false,
      maxValue: 1.0,
      openAtMax: false,
    },
  },
};

/** A real, deterministic evaluator that scores every invocation as passing. */
class TrivialEvaluator extends Evaluator {
  constructor(_options: EvaluatorConstructorOptions) {
    super();
  }

  override evaluateInvocations(
    actualInvocations: Invocation[],
  ): EvaluationResult {
    return {
      overallScore: 1.0,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: actualInvocations.map((actual) => ({
        actualInvocation: actual,
        score: 1.0,
        evalStatus: EvalStatus.PASSED,
      })),
    };
  }
}

/** A minimal in-memory {@link EvalSetsManager} backed by a single eval set. */
class SingleEvalSetManager implements EvalSetsManager {
  constructor(
    private readonly appName: string,
    private readonly evalSet: EvalSet,
  ) {}

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    if (appName === this.appName && evalSetId === this.evalSet.evalSetId) {
      return this.evalSet;
    }
    return undefined;
  }

  async getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined> {
    const evalSet = await this.getEvalSet(appName, evalSetId);
    return evalSet?.evalCases.find(
      (evalCase) => evalCase.evalId === evalCaseId,
    );
  }

  async createEvalSet(): Promise<EvalSet> {
    throw new Error('not implemented');
  }
  async listEvalSets(): Promise<string[]> {
    throw new Error('not implemented');
  }
  async addEvalCase(): Promise<void> {
    throw new Error('not implemented');
  }
  async updateEvalCase(): Promise<void> {
    throw new Error('not implemented');
  }
  async deleteEvalCase(): Promise<void> {
    throw new Error('not implemented');
  }
}

describe('LocalEvalService (end-to-end)', () => {
  it('runs inference then evaluation over an in-memory eval set', async () => {
    const appName = 'e2e_app';
    const evalSet: EvalSet = {
      evalSetId: 'e2e_set',
      evalCases: [
        {
          evalId: 'case1',
          conversation: [
            {
              invocationId: '',
              userContent: {role: 'user', parts: [{text: 'Hi there.'}]},
              creationTimestamp: 0,
            },
          ],
          creationTimestamp: 0,
          finalSessionState: {},
        },
      ],
      creationTimestamp: 0,
    };

    const registry = new MetricEvaluatorRegistry();
    registry.registerEvaluator(TRIVIAL_METRIC_INFO, TrivialEvaluator);

    const service = new LocalEvalService({
      rootAgent: new LlmAgent({
        name: 'e2e_agent',
        model: new FixedResponseModel(),
      }),
      evalSetsManager: new SingleEvalSetManager(appName, evalSet),
      metricEvaluatorRegistry: registry,
    });

    // 1. Inference streams one InferenceResult for the single eval case.
    const inferenceResults: InferenceResult[] = [];
    for await (const inference of service.performInference({
      appName,
      evalSetId: 'e2e_set',
      inferenceConfig: {
        parallelism: 2,
        useLive: false,
        liveTimeoutSeconds: 300,
      },
    })) {
      inferenceResults.push(inference);
    }

    expect(inferenceResults).toHaveLength(1);
    expect(inferenceResults[0].status).toBe(InferenceStatus.SUCCESS);
    expect(inferenceResults[0].inferences).toHaveLength(1);
    expect(
      inferenceResults[0].inferences?.[0].finalResponse?.parts?.[0].text,
    ).toBe('Hello from the agent.');

    // 2. Evaluation streams one EvalCaseResult, scored by the trivial metric.
    const evalResults: EvalCaseResult[] = [];
    for await (const result of service.evaluate({
      inferenceResults,
      evaluateConfig: {
        evalMetrics: [{metricName: 'e2e_trivial_metric', threshold: 0.5}],
        parallelism: 2,
      },
    })) {
      evalResults.push(result);
    }

    expect(evalResults).toHaveLength(1);
    expect(evalResults[0].evalId).toBe('case1');
    expect(evalResults[0].finalEvalStatus).toBe(EvalStatus.PASSED);
    expect(evalResults[0].overallEvalMetricResults[0].metricName).toBe(
      'e2e_trivial_metric',
    );
    expect(evalResults[0].overallEvalMetricResults[0].score).toBe(1.0);
  });
});
