/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalStatus} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  createEvalSetResult,
  parseEvalSetResultJson,
  serializeEvalSetResult,
} from '../../src/evaluation/eval_set_result_utils.js';

const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';

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
