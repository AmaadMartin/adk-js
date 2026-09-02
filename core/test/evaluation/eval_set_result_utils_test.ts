/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  EvalCaseResult,
  EvalMetric,
  EvalMetricResult,
  EvalSetResult,
  EvalStatus,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  createEvalSetResult,
  parseEvalSetResultJson,
  serializeEvalSetResult,
} from '../../src/evaluation/eval_set_result_utils.js';

const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';

const SESSION_ID = 'inference_session';
const USER_ID = 'operator';
const LEGACY_EVAL_SET_FILE = 'evals/smoke.evalset.json';
const RESULT_ID = `${APP_NAME}_${EVAL_SET_ID}_1700000000`;
const TIMESTAMP = 1700000000;

const METRIC: EvalMetric = {
  metricName: 'response_match_score',
  criterion: {threshold: 0.8},
};
const METRIC_RESULT: EvalMetricResult = {
  ...METRIC,
  score: 0.9,
  evalStatus: EvalStatus.PASSED,
};

/** The camelCase form of a result file, i.e. `model_dump_json(by_alias=True)`. */
const CAMEL_CASE_RESULT: EvalSetResult = {
  evalSetResultId: RESULT_ID,
  evalSetResultName: RESULT_ID,
  evalSetId: EVAL_SET_ID,
  evalCaseResults: [
    {
      evalSetFile: LEGACY_EVAL_SET_FILE,
      evalSetId: EVAL_SET_ID,
      evalId: 'lights_on',
      finalEvalStatus: EvalStatus.PASSED,
      evalMetricResults: [[METRIC, METRIC_RESULT]],
      overallEvalMetricResults: [METRIC_RESULT],
      evalMetricResultPerInvocation: [],
      sessionId: SESSION_ID,
      sessionDetails: {
        id: SESSION_ID,
        appName: APP_NAME,
        userId: USER_ID,
        state: {user_name: 'Ada'},
        events: [],
        lastUpdateTime: TIMESTAMP,
      },
      userId: USER_ID,
    },
  ],
  creationTimestamp: TIMESTAMP,
};

/** The snake_case form of the same file, i.e. `model_dump_json()`. */
const SNAKE_CASE_RESULT = {
  eval_set_result_id: RESULT_ID,
  eval_set_result_name: RESULT_ID,
  eval_set_id: EVAL_SET_ID,
  eval_case_results: [
    {
      eval_set_file: LEGACY_EVAL_SET_FILE,
      eval_set_id: EVAL_SET_ID,
      eval_id: 'lights_on',
      final_eval_status: 1,
      eval_metric_results: [
        [
          {metric_name: METRIC.metricName, criterion: {threshold: 0.8}},
          {
            metric_name: METRIC.metricName,
            criterion: {threshold: 0.8},
            score: 0.9,
            eval_status: 1,
          },
        ],
      ],
      overall_eval_metric_results: [
        {
          metric_name: METRIC.metricName,
          criterion: {threshold: 0.8},
          score: 0.9,
          eval_status: 1,
        },
      ],
      eval_metric_result_per_invocation: [],
      session_id: SESSION_ID,
      session_details: {
        id: SESSION_ID,
        app_name: APP_NAME,
        user_id: USER_ID,
        state: {user_name: 'Ada'},
        events: [],
        last_update_time: TIMESTAMP,
      },
      user_id: USER_ID,
    },
  ],
  creation_timestamp: TIMESTAMP,
};

/** A session an eval service recorded, carrying maps keyed by user data. */
function recordedSession(): Session {
  return createSession({
    id: SESSION_ID,
    appName: APP_NAME,
    userId: USER_ID,
    state: {user_name: 'Ada'},
    lastUpdateTime: TIMESTAMP,
    events: [
      createEvent({
        id: 'event_1',
        invocationId: 'invocation_1',
        author: 'home_assistant',
        timestamp: TIMESTAMP,
        actions: {
          stateDelta: {user_name: 'Ada'},
          artifactDelta: {'my_file.png': 1},
          agentState: {last_node: 'lights'},
        },
      }),
    ],
  });
}

describe('createEvalSetResult', () => {
  it('names the result after the app, the eval set and the time', () => {
    const before = Date.now() / 1000;

    const result = createEvalSetResult(APP_NAME, EVAL_SET_ID, []);

    expect(result.evalSetResultId).toBe(
      `${APP_NAME}_${EVAL_SET_ID}_${result.creationTimestamp}`,
    );
    expect(result.evalSetResultName).toBe(result.evalSetResultId);
    expect(result.creationTimestamp).toBeGreaterThanOrEqual(before);
  });

  it('keeps a slash in the app name out of the file name', () => {
    const result = createEvalSetResult('team/app', EVAL_SET_ID, []);

    expect(result.evalSetResultId).toContain('team/app');
    expect(result.evalSetResultName).not.toContain('/');
  });
});

describe('serializeEvalSetResult', () => {
  it('writes the field names adk-python writes', () => {
    const result = createEvalSetResult(APP_NAME, EVAL_SET_ID, [
      {
        evalSetId: EVAL_SET_ID,
        evalId: 'lights_on',
        finalEvalStatus: EvalStatus.PASSED,
        evalMetricResultPerInvocation: [],
        sessionId: SESSION_ID,
      },
    ]);

    expect(JSON.parse(serializeEvalSetResult(result))).toEqual({
      eval_set_result_id: result.evalSetResultId,
      eval_set_result_name: result.evalSetResultName,
      eval_set_id: EVAL_SET_ID,
      eval_case_results: [
        {
          eval_set_id: EVAL_SET_ID,
          eval_id: 'lights_on',
          final_eval_status: 1,
          eval_metric_result_per_invocation: [],
          session_id: SESSION_ID,
        },
      ],
      creation_timestamp: result.creationTimestamp,
    });
  });
});

describe('parseEvalSetResultJson', () => {
  it('round-trips a result this package wrote', () => {
    const result = createEvalSetResult(APP_NAME, EVAL_SET_ID, []);

    expect(parseEvalSetResultJson(serializeEvalSetResult(result))).toEqual(
      result,
    );
  });

  it('defaults the name and the timestamp a file omits', () => {
    const parsed = parseEvalSetResultJson(
      JSON.stringify({
        eval_set_result_id: 'run_a',
        eval_set_id: EVAL_SET_ID,
        eval_case_results: [],
      }),
    );

    expect(parsed.evalSetResultName).toBeUndefined();
    expect(parsed.creationTimestamp).toBe(0);
  });

  it('refuses JSON that is not an object', () => {
    expect(() => parseEvalSetResultJson('42')).toThrowError(
      'An eval set result must be a JSON object.',
    );
  });

  it('refuses a result without its identifiers', () => {
    expect(() =>
      parseEvalSetResultJson(JSON.stringify({eval_set_id: EVAL_SET_ID})),
    ).toThrowError(
      'An eval set result must have an `eval_set_result_id` and an ' +
        '`eval_set_id`.',
    );
    expect(() =>
      parseEvalSetResultJson(JSON.stringify({eval_set_result_id: 'run_a'})),
    ).toThrowError(
      'An eval set result must have an `eval_set_result_id` and an ' +
        '`eval_set_id`.',
    );
  });

  it('refuses a result without its case results', () => {
    expect(() =>
      parseEvalSetResultJson(
        JSON.stringify({
          eval_set_result_id: 'run_a',
          eval_set_id: EVAL_SET_ID,
        }),
      ),
    ).toThrowError('An eval set result must have `eval_case_results`.');
  });
});

describe('serializeEvalSetResult with every declared field', () => {
  it('writes the ten case-result fields in snake_case', () => {
    const result = createEvalSetResult(APP_NAME, EVAL_SET_ID, [
      {...CAMEL_CASE_RESULT.evalCaseResults[0]},
    ]);

    const written = JSON.parse(serializeEvalSetResult(result)) as Record<
      string,
      unknown
    >;
    const cases = written['eval_case_results'] as Array<
      Record<string, unknown>
    >;

    expect(Object.keys(cases[0]).sort()).toEqual([
      'eval_id',
      'eval_metric_result_per_invocation',
      'eval_metric_results',
      'eval_set_file',
      'eval_set_id',
      'final_eval_status',
      'overall_eval_metric_results',
      'session_details',
      'session_id',
      'user_id',
    ]);
    expect(cases[0]['session_id']).toBe(SESSION_ID);
    expect(cases[0]['user_id']).toBe(USER_ID);
    expect(cases[0]['eval_set_file']).toBe(LEGACY_EVAL_SET_FILE);
  });
});

describe('parseEvalSetResultJson with every declared field', () => {
  it('reads the snake_case keys adk-python writes', () => {
    const parsed = parseEvalSetResultJson(JSON.stringify(SNAKE_CASE_RESULT));

    expect(parsed).toEqual(CAMEL_CASE_RESULT);
  });

  it('reads camelCase keys as the same result', () => {
    const parsed = parseEvalSetResultJson(JSON.stringify(CAMEL_CASE_RESULT));

    expect(parsed).toEqual(CAMEL_CASE_RESULT);
  });

  it('reads a double-encoded legacy file', () => {
    const encoded = JSON.stringify(JSON.stringify(SNAKE_CASE_RESULT));

    expect(parseEvalSetResultJson(encoded)).toEqual(CAMEL_CASE_RESULT);
  });

  it('keeps the deprecated fields beside their replacements', () => {
    const result: EvalSetResult = {
      ...CAMEL_CASE_RESULT,
      evalCaseResults: [
        {...CAMEL_CASE_RESULT.evalCaseResults[0], sessionDetails: undefined},
      ],
    };

    const parsed = parseEvalSetResultJson(serializeEvalSetResult(result));
    const parsedCase = parsed.evalCaseResults[0];

    expect(parsedCase.evalSetFile).toBe(LEGACY_EVAL_SET_FILE);
    expect(parsedCase.evalSetId).toBe(EVAL_SET_ID);
    expect(parsedCase.evalMetricResults).toEqual([[METRIC, METRIC_RESULT]]);
    expect(parsedCase.overallEvalMetricResults).toEqual([METRIC_RESULT]);
  });

  it('keeps the user-keyed maps of a recorded session', () => {
    const caseResult: EvalCaseResult = {
      ...CAMEL_CASE_RESULT.evalCaseResults[0],
      sessionDetails: recordedSession(),
    };
    const result: EvalSetResult = {
      ...CAMEL_CASE_RESULT,
      evalCaseResults: [caseResult],
    };

    const written = JSON.parse(serializeEvalSetResult(result)) as Record<
      string,
      unknown
    >;
    const writtenCases = written['eval_case_results'] as Array<
      Record<string, unknown>
    >;
    const writtenSession = writtenCases[0]['session_details'] as Record<
      string,
      unknown
    >;

    expect(Object.keys(writtenSession).sort()).toEqual([
      'app_name',
      'events',
      'id',
      'last_update_time',
      'state',
      'user_id',
    ]);

    const parsedSession = parseEvalSetResultJson(serializeEvalSetResult(result))
      .evalCaseResults[0].sessionDetails;
    if (!parsedSession) {
      expect.fail('the round-trip dropped the recorded session');
    }
    const actions = parsedSession.events[0].actions;

    expect(parsedSession.appName).toBe(APP_NAME);
    expect(parsedSession.userId).toBe(USER_ID);
    expect(parsedSession.lastUpdateTime).toBe(TIMESTAMP);
    expect(parsedSession.state).toEqual({user_name: 'Ada'});
    expect(actions.stateDelta).toEqual({user_name: 'Ada'});
    expect(actions.artifactDelta).toEqual({'my_file.png': 1});
    expect(actions.agentState).toEqual({last_node: 'lights'});
  });
});
