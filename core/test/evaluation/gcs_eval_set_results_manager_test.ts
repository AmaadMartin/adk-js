/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCaseResult,
  EvalStatus,
  GcsEvalSetResultsManager,
  InputValidationError,
  NotFoundError,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {fakeStorage} from './fake_gcs_storage.js';

vi.mock('@google-cloud/storage', async () => {
  const {fakeStorage: storage} = await import('./fake_gcs_storage.js');
  return {Storage: vi.fn(() => storage)};
});

const BUCKET = 'evals-bucket';
const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';
const HISTORY_PREFIX = `${APP_NAME}/evals/eval_history`;

const CASE_RESULT: EvalCaseResult = {
  evalSetId: EVAL_SET_ID,
  evalId: 'lights_on',
  finalEvalStatus: EvalStatus.FAILED,
  evalMetricResultPerInvocation: [],
  sessionId: 'lights_on_session',
};

let manager: GcsEvalSetResultsManager;

function blobNames(): string[] {
  return [...fakeStorage.bucket(BUCKET).blobs.keys()].sort();
}

beforeEach(() => {
  fakeStorage.reset();
  fakeStorage.existingBuckets.add(BUCKET);
  manager = new GcsEvalSetResultsManager(BUCKET);
});

describe('GcsEvalSetResultsManager', () => {
  it('writes one result blob under the eval history prefix', async () => {
    await manager.saveEvalSetResult(APP_NAME, EVAL_SET_ID, [CASE_RESULT]);

    const names = blobNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(
      new RegExp(
        `^${HISTORY_PREFIX}/${APP_NAME}_${EVAL_SET_ID}_[0-9.]+` +
          `\\.evalset_result\\.json$`,
      ),
    );
    const blob = fakeStorage.bucket(BUCKET).blobs.get(names[0]);
    expect(blob?.contentType).toBe('application/json');
    expect(JSON.parse(blob?.contents ?? '')).toMatchObject({
      eval_set_id: EVAL_SET_ID,
      eval_case_results: [{eval_id: 'lights_on', final_eval_status: 2}],
    });
  });

  it('reads back a result it saved', async () => {
    await manager.saveEvalSetResult(APP_NAME, EVAL_SET_ID, [CASE_RESULT]);
    const [savedId] = await manager.listEvalSetResults(APP_NAME);

    const result = await manager.getEvalSetResult(APP_NAME, savedId);

    expect(result.evalSetResultId).toBe(savedId);
    expect(result.evalCaseResults).toEqual([CASE_RESULT]);
  });

  it('reports a result id it does not hold', async () => {
    await expect(
      manager.getEvalSetResult(APP_NAME, 'never_saved'),
    ).rejects.toThrowError(
      new NotFoundError('Eval set result `never_saved` not found.'),
    );
  });

  it('lists only result blobs of that app, sorted', async () => {
    const bucket = fakeStorage.bucket(BUCKET);
    bucket.blobs.set(`${HISTORY_PREFIX}/run_b.evalset_result.json`, {
      contents: '{}',
    });
    bucket.blobs.set(`${HISTORY_PREFIX}/run_a.evalset_result.json`, {
      contents: '{}',
    });
    bucket.blobs.set(`${HISTORY_PREFIX}/notes.txt`, {contents: 'x'});
    bucket.blobs.set('other_app/evals/eval_history/run_c.evalset_result.json', {
      contents: '{}',
    });

    expect(await manager.listEvalSetResults(APP_NAME)).toEqual([
      'run_a',
      'run_b',
    ]);
  });

  it('reports no results for an app that has none', async () => {
    expect(await manager.listEvalSetResults('unknown')).toEqual([]);
  });

  it('refuses identifiers that walk out of the prefix', async () => {
    await expect(
      manager.saveEvalSetResult('../escape', EVAL_SET_ID, []),
    ).rejects.toThrow(InputValidationError);
    await expect(
      manager.saveEvalSetResult(APP_NAME, '../escape', []),
    ).rejects.toThrow(InputValidationError);
    await expect(
      manager.getEvalSetResult(APP_NAME, '../escape'),
    ).rejects.toThrow(InputValidationError);
  });

  it('reports a bucket that does not exist', async () => {
    const missing = new GcsEvalSetResultsManager('no-such-bucket');

    await expect(missing.listEvalSetResults(APP_NAME)).rejects.toThrow(
      'Bucket `no-such-bucket` does not exist. Please create it before using ' +
        'the GcsEvalSetResultsManager.',
    );
  });
});
