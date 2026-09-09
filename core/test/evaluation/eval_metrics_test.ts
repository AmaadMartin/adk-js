/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCaseResult,
  EvalMetric,
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalStatus,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('EvalStatus', () => {
  // Pinned against adk-python `eval_metrics.py`: the numeric values are
  // serialized into eval results, so they are part of the wire contract.
  it('matches the adk-python numeric values', () => {
    expect(EvalStatus.PASSED).toBe(1);
    expect(EvalStatus.FAILED).toBe(2);
    expect(EvalStatus.NOT_EVALUATED).toBe(3);
  });
});

describe('EvalCaseResult serialization', () => {
  it('round-trips through JSON with the adk-python key set', () => {
    const metric: EvalMetric = {
      metricName: 'rubric_based_final_response_quality_v1',
      criterion: {threshold: 0.7, includeIntermediateResponsesInFinal: true},
    };
    const metricResult: EvalMetricResult = {
      ...metric,
      score: 0.5,
      evalStatus: EvalStatus.FAILED,
      details: {
        rubricScores: [
          {rubricId: 'grammar', rationale: 'two typos', score: 0.5},
        ],
      },
    };
    const perInvocation: EvalMetricResultPerInvocation = {
      actualInvocation: {
        invocationId: 'invocation-1',
        userContent: {role: 'user', parts: [{text: 'summarize this'}]},
        rubrics: [
          {
            rubricId: 'grammar',
            rubricContent: {textProperty: 'The response reads correctly.'},
            type: 'FINAL_RESPONSE_QUALITY',
          },
        ],
        appDetails: {
          agentDetails: {
            root: {name: 'root', instructions: 'Summarize the input.'},
          },
        },
      },
      expectedInvocation: {
        userContent: {role: 'user', parts: [{text: 'summarize this'}]},
        finalResponse: {role: 'model', parts: [{text: 'a summary'}]},
      },
      evalMetricResults: [metricResult],
    };
    const caseResult: EvalCaseResult = {
      evalSetId: 'smoke',
      evalId: 'case-1',
      finalEvalStatus: EvalStatus.FAILED,
      overallEvalMetricResults: [metricResult],
      evalMetricResultPerInvocation: [perInvocation],
      sessionId: 'session-1',
      userId: 'user-1',
    };

    const roundTripped: EvalCaseResult = JSON.parse(JSON.stringify(caseResult));

    expect(Object.keys(roundTripped).sort()).toEqual([
      'evalId',
      'evalMetricResultPerInvocation',
      'evalSetId',
      'finalEvalStatus',
      'overallEvalMetricResults',
      'sessionId',
      'userId',
    ]);
    expect(roundTripped).toEqual(caseResult);
  });

  it('treats NOT_EVALUATED as neither passed nor failed', () => {
    const caseResult: EvalCaseResult = {
      finalEvalStatus: EvalStatus.NOT_EVALUATED,
      overallEvalMetricResults: [],
      evalMetricResultPerInvocation: [],
      sessionId: 'session-1',
    };

    expect(caseResult.finalEvalStatus === EvalStatus.PASSED).toBe(false);
    expect(caseResult.finalEvalStatus === EvalStatus.FAILED).toBe(false);
  });
});
