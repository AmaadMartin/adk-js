/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Test doubles for the eval runtime that {@link AgentEvaluator} drives. */

import {
  BaseEvalService,
  EvalCaseResult,
  EvalRuntime,
  EvalServiceParams,
  EvalSetResult,
  EvalSetResultsManager,
  EvaluateRequest,
  InferenceRequest,
  InferenceResult,
  InferenceStatus,
  NotFoundError,
} from '@google/adk';

/** Records every eval set result the eval service saves. */
export class RecordingEvalSetResultsManager implements EvalSetResultsManager {
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

  async getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult> {
    throw new NotFoundError(`No result ${evalSetResultId} for app ${appName}.`);
  }

  async listEvalSetResults(): Promise<string[]> {
    return [];
  }
}

/**
 * An eval service whose results are scripted.
 *
 * It persists the eval case results through the results manager it was built
 * with before it yields them, the way a real eval service does, so that a
 * caller can observe that results survive a failing run.
 */
export class StubEvalService implements BaseEvalService {
  readonly inferenceRequests: InferenceRequest[] = [];
  readonly evaluateRequests: EvaluateRequest[] = [];

  constructor(
    private readonly evalCaseResults: EvalCaseResult[] = [],
    private readonly params?: EvalServiceParams,
  ) {}

  async *performInference(
    inferenceRequest: InferenceRequest,
  ): AsyncGenerator<InferenceResult> {
    this.inferenceRequests.push(inferenceRequest);
    yield {
      appName: inferenceRequest.appName,
      evalSetId: inferenceRequest.evalSetId,
      evalCaseId: `case-${this.inferenceRequests.length}`,
      status: InferenceStatus.SUCCESS,
    };
  }

  async *evaluate(
    evaluateRequest: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult> {
    this.evaluateRequests.push(evaluateRequest);
    const manager = this.params?.evalSetResultsManager;
    if (manager) {
      await manager.saveEvalSetResult(
        'unused',
        this.evalCaseResults[0]?.evalSetId ?? '',
        this.evalCaseResults,
      );
    }
    for (const evalCaseResult of this.evalCaseResults) {
      yield evalCaseResult;
    }
  }
}

/** An eval runtime that records the params it built each service with. */
export class StubEvalRuntime implements EvalRuntime {
  readonly allParams: EvalServiceParams[] = [];
  readonly allServices: StubEvalService[] = [];

  constructor(private readonly evalCaseResults: EvalCaseResult[] = []) {}

  /** The params of the most recently built service. */
  get params(): EvalServiceParams | undefined {
    return this.allParams.at(-1);
  }

  /** The most recently built service. */
  get service(): StubEvalService | undefined {
    return this.allServices.at(-1);
  }

  createEvalService(params: EvalServiceParams): BaseEvalService {
    const service = new StubEvalService(this.evalCaseResults, params);
    this.allParams.push(params);
    this.allServices.push(service);
    return service;
  }
}
