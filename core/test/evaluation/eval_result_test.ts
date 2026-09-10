/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference: `google/adk-python`, `src/google/adk/evaluation/eval_result.py`
 * on `main`. The models are the document `adk eval` writes and both SDKs read,
 * so the tests pin the on-disk field names and the eval status integers.
 */

import {Session} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, expectTypeOf, it} from 'vitest';
import {
  EvalMetricResult,
  EvalMetricResultPerInvocation,
} from '../../src/evaluation/eval_metrics.js';
import {
  EvalCaseResult,
  EvalSetResult,
  EvalStatus,
  Invocation,
} from '../../src/evaluation/index.js';
import {
  toCamelCase,
  toSnakeCase,
} from '../../src/utils/object_notation_utils.js';

const USER_CONTENT: Content = {
  role: 'user',
  parts: [{text: 'turn the lights on'}],
};

const FINAL_RESPONSE: Content = {
  role: 'model',
  parts: [{text: 'the lights are on'}],
};

const INVOCATION: Invocation = {
  invocationId: 'invocation-1',
  userContent: USER_CONTENT,
  finalResponse: FINAL_RESPONSE,
  creationTimestamp: 1700000000,
};

const METRIC_RESULT: EvalMetricResult = {
  metricName: 'response_match_score',
  score: 0.9,
  evalStatus: EvalStatus.PASSED,
};

const PER_INVOCATION_RESULT: EvalMetricResultPerInvocation = {
  actualInvocation: INVOCATION,
  expectedInvocation: INVOCATION,
  evalMetricResults: [METRIC_RESULT],
};

const SESSION: Session = {
  id: 'inference_session',
  appName: 'home_automation',
  userId: 'test_user',
  state: {},
  events: [],
  lastUpdateTime: 1700000000,
};

const CASE_RESULT: EvalCaseResult = {
  evalSetFile: 'smoke.evalset.json',
  evalSetId: 'smoke',
  evalId: 'lights_on',
  finalEvalStatus: EvalStatus.PASSED,
  evalMetricResults: [[{metricName: 'response_match_score'}, METRIC_RESULT]],
  overallEvalMetricResults: [METRIC_RESULT],
  evalMetricResultPerInvocation: [PER_INVOCATION_RESULT],
  sessionId: 'inference_session',
  sessionDetails: SESSION,
  userId: 'test_user',
};

const SET_RESULT: EvalSetResult = {
  evalSetResultId: 'home_automation_smoke_1700000000',
  evalSetResultName: 'home_automation_smoke_1700000000',
  evalSetId: 'smoke',
  evalCaseResults: [CASE_RESULT],
  creationTimestamp: 1700000000,
};

/** The document adk-python's `model_dump_json()` writes for {@link SESSION}. */
const SNAKE_CASE_SESSION = {
  id: 'inference_session',
  app_name: 'home_automation',
  user_id: 'test_user',
  state: {},
  events: [],
  last_update_time: 1700000000,
};

/** The document adk-python writes for {@link INVOCATION}. */
const SNAKE_CASE_INVOCATION = {
  invocation_id: 'invocation-1',
  user_content: {role: 'user', parts: [{text: 'turn the lights on'}]},
  final_response: {role: 'model', parts: [{text: 'the lights are on'}]},
  creation_timestamp: 1700000000,
};

/** The document adk-python writes for {@link METRIC_RESULT}. */
const SNAKE_CASE_METRIC_RESULT = {
  metric_name: 'response_match_score',
  score: 0.9,
  eval_status: EvalStatus.PASSED,
};

/** The document adk-python writes for {@link CASE_RESULT}. */
const SNAKE_CASE_CASE_RESULT = {
  eval_set_file: 'smoke.evalset.json',
  eval_set_id: 'smoke',
  eval_id: 'lights_on',
  final_eval_status: EvalStatus.PASSED,
  eval_metric_results: [
    [{metric_name: 'response_match_score'}, SNAKE_CASE_METRIC_RESULT],
  ],
  overall_eval_metric_results: [SNAKE_CASE_METRIC_RESULT],
  eval_metric_result_per_invocation: [
    {
      actual_invocation: SNAKE_CASE_INVOCATION,
      expected_invocation: SNAKE_CASE_INVOCATION,
      eval_metric_results: [SNAKE_CASE_METRIC_RESULT],
    },
  ],
  session_id: 'inference_session',
  session_details: SNAKE_CASE_SESSION,
  user_id: 'test_user',
};

/** The document adk-python writes for {@link SET_RESULT}. */
const SNAKE_CASE_SET_RESULT = {
  eval_set_result_id: 'home_automation_smoke_1700000000',
  eval_set_result_name: 'home_automation_smoke_1700000000',
  eval_set_id: 'smoke',
  eval_case_results: [SNAKE_CASE_CASE_RESULT],
  creation_timestamp: 1700000000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    expect.fail(`expected an object, got ${JSON.stringify(value)}`);
  }
  return value;
}

function firstOf(value: unknown): unknown {
  if (!Array.isArray(value)) {
    expect.fail(`expected an array, got ${JSON.stringify(value)}`);
  }
  return value[0];
}

describe('EvalCaseResult', () => {
  it('serializes an eval case result under the field names adk-python writes', () => {
    const serialized = toSnakeCase(CASE_RESULT);

    expect(Object.keys(asRecord(serialized))).toEqual([
      'eval_set_file',
      'eval_set_id',
      'eval_id',
      'final_eval_status',
      'eval_metric_results',
      'overall_eval_metric_results',
      'eval_metric_result_per_invocation',
      'session_id',
      'session_details',
      'user_id',
    ]);
    expect(serialized).toEqual(SNAKE_CASE_CASE_RESULT);
  });

  it('records the eval status as the integer adk-python writes', () => {
    const statuses = [
      EvalStatus.PASSED,
      EvalStatus.FAILED,
      EvalStatus.NOT_EVALUATED,
    ];

    const serialized = statuses.map((finalEvalStatus) =>
      toSnakeCase({...CASE_RESULT, finalEvalStatus}),
    );

    expect(
      serialized.map((result) => asRecord(result)['final_eval_status']),
    ).toEqual([1, 2, 3]);
  });

  it('builds a case result without the deprecated or session fields', () => {
    const minimal: EvalCaseResult = {
      evalSetId: 'smoke',
      evalId: 'lights_on',
      finalEvalStatus: EvalStatus.NOT_EVALUATED,
      overallEvalMetricResults: [],
      evalMetricResultPerInvocation: [],
      sessionId: '',
    };

    expect(toSnakeCase(minimal)).toEqual({
      eval_set_id: 'smoke',
      eval_id: 'lights_on',
      final_eval_status: EvalStatus.NOT_EVALUATED,
      overall_eval_metric_results: [],
      eval_metric_result_per_invocation: [],
      session_id: '',
    });
  });

  // A compile-time claim: tsc fails this case, the runner cannot.
  it('requires the overall metric results on every case result', () => {
    expectTypeOf<EvalCaseResult['overallEvalMetricResults']>().toEqualTypeOf<
      EvalMetricResult[]
    >();
  });
});

describe('EvalSetResult', () => {
  it('serializes an eval set result under the field names adk-python writes', () => {
    const serialized = toSnakeCase(SET_RESULT);

    expect(Object.keys(asRecord(serialized))).toEqual([
      'eval_set_result_id',
      'eval_set_result_name',
      'eval_set_id',
      'eval_case_results',
      'creation_timestamp',
    ]);
    expect(
      Object.keys(asRecord(firstOf(asRecord(serialized)['eval_case_results']))),
    ).toContain('overall_eval_metric_results');
    expect(serialized).toEqual(SNAKE_CASE_SET_RESULT);
  });

  it('reads back a result document adk-python wrote', () => {
    expect(toCamelCase(SNAKE_CASE_SET_RESULT)).toEqual(SET_RESULT);
  });

  // A compile-time claim: tsc fails this case, the runner cannot.
  it('requires every eval set result field adk-python requires', () => {
    expectTypeOf<EvalSetResult['evalSetResultId']>().toEqualTypeOf<string>();
    expectTypeOf<EvalSetResult['evalSetId']>().toEqualTypeOf<string>();
    expectTypeOf<EvalSetResult['evalCaseResults']>().toEqualTypeOf<
      EvalCaseResult[]
    >();
    expectTypeOf<EvalSetResult['creationTimestamp']>().toEqualTypeOf<number>();
    expectTypeOf<EvalSetResult['evalSetResultName']>().toEqualTypeOf<
      string | undefined
    >();
  });
});
