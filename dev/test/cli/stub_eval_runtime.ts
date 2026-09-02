/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An eval runtime for the `adk eval` tests.
 *
 * It behaves like a real one where the command can observe it: it reads the
 * eval cases through the eval sets manager it was given, honours the eval case
 * selector, and persists the results through the results manager. The scores
 * themselves are fixed, so a run is deterministic and offline.
 */

import {
  BaseEvalService,
  EvalCaseResult,
  EvalRuntime,
  EvalServiceParams,
  EvalStatus,
  EvaluateRequest,
  InferenceRequest,
  InferenceResult,
  InferenceStatus,
} from '@google/adk';

/** The metric the stub reports a verdict for. */
const STUB_METRIC_NAME = 'response_match_score';

/** The score of an eval case the stub passes. */
const PASSING_SCORE = 1;

/** The score of an eval case the stub fails. */
const FAILING_SCORE = 0.5;

/** Every second eval case fails, so a summary shows both counts. */
function statusOf(index: number): EvalStatus {
  return index % 2 === 0 ? EvalStatus.PASSED : EvalStatus.FAILED;
}

/** An eval service whose verdicts are fixed. */
export class StubEvalService implements BaseEvalService {
  readonly inferenceRequests: InferenceRequest[] = [];
  readonly evaluateRequests: EvaluateRequest[] = [];

  constructor(private readonly params: EvalServiceParams) {}

  async *performInference(
    inferenceRequest: InferenceRequest,
  ): AsyncGenerator<InferenceResult> {
    this.inferenceRequests.push(inferenceRequest);
    const evalSet = await this.params.evalSetsManager.getEvalSet(
      inferenceRequest.appName,
      inferenceRequest.evalSetId,
    );
    const wanted = inferenceRequest.evalCaseIds;
    for (const evalCase of evalSet?.evalCases ?? []) {
      if (wanted && !wanted.includes(evalCase.evalId)) {
        continue;
      }
      yield {
        appName: inferenceRequest.appName,
        evalSetId: inferenceRequest.evalSetId,
        evalCaseId: evalCase.evalId,
        inferences: evalCase.conversation,
        status: InferenceStatus.SUCCESS,
      };
    }
  }

  async *evaluate(
    evaluateRequest: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult> {
    this.evaluateRequests.push(evaluateRequest);
    const results = evaluateRequest.inferenceResults.map(
      (inferenceResult, index): EvalCaseResult => ({
        evalSetId: inferenceResult.evalSetId,
        evalId: inferenceResult.evalCaseId,
        finalEvalStatus: statusOf(index),
        overallEvalMetricResults: [
          {
            metricName: STUB_METRIC_NAME,
            criterion: {threshold: 0.8},
            score:
              statusOf(index) === EvalStatus.PASSED
                ? PASSING_SCORE
                : FAILING_SCORE,
            evalStatus: statusOf(index),
          },
        ],
        evalMetricResultPerInvocation: (inferenceResult.inferences ?? []).map(
          (invocation) => ({
            actualInvocation: invocation,
            expectedInvocation: invocation,
            evalMetricResults: [
              {
                metricName: STUB_METRIC_NAME,
                criterion: {threshold: 0.8},
                score: PASSING_SCORE,
                evalStatus: statusOf(index),
              },
            ],
          }),
        ),
      }),
    );

    for (const [appName, evalSetId] of resultKeys(
      evaluateRequest.inferenceResults,
    )) {
      await this.params.evalSetResultsManager?.saveEvalSetResult(
        appName,
        evalSetId,
        results.filter((result) => result.evalSetId === evalSetId),
      );
    }
    for (const result of results) {
      yield result;
    }
  }
}

/** The distinct `[appName, evalSetId]` pairs the inferences came from. */
function resultKeys(
  inferenceResults: readonly InferenceResult[],
): Array<[string, string]> {
  const keys = new Map<string, [string, string]>();
  for (const inferenceResult of inferenceResults) {
    keys.set(`${inferenceResult.appName}/${inferenceResult.evalSetId}`, [
      inferenceResult.appName,
      inferenceResult.evalSetId,
    ]);
  }
  return [...keys.values()];
}

/** An eval runtime that records the params it built each service with. */
export class StubEvalRuntime implements EvalRuntime {
  readonly allParams: EvalServiceParams[] = [];
  readonly allServices: StubEvalService[] = [];

  /** The params of the most recently built service. */
  get params(): EvalServiceParams | undefined {
    return this.allParams.at(-1);
  }

  /** The most recently built service. */
  get service(): StubEvalService | undefined {
    return this.allServices.at(-1);
  }

  createEvalService(params: EvalServiceParams): BaseEvalService {
    const service = new StubEvalService(params);
    this.allParams.push(params);
    this.allServices.push(service);
    return service;
  }
}
