/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AlreadyExistsError,
  EvalCase,
  GcsEvalSetsManager,
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
const BLOB_NAME = `${APP_NAME}/evals/eval_sets/${EVAL_SET_ID}.evalset.json`;

let manager: GcsEvalSetsManager;

function evalCase(evalId: string, text: string): EvalCase {
  return {
    evalId,
    conversation: [{userContent: {role: 'user', parts: [{text}]}}],
    creationTimestamp: 1,
  };
}

function writeBlob(name: string, contents: unknown): void {
  fakeStorage
    .bucket(BUCKET)
    .blobs.set(name, {contents: JSON.stringify(contents)});
}

function readBlob(name: string): Record<string, unknown> {
  const blob = fakeStorage.bucket(BUCKET).blobs.get(name);
  if (!blob) {
    expect.fail(`Expected the manager to have written ${name}.`);
  }
  return JSON.parse(blob.contents);
}

beforeEach(() => {
  fakeStorage.reset();
  fakeStorage.existingBuckets.add(BUCKET);
  manager = new GcsEvalSetsManager(BUCKET);
});

describe('GcsEvalSetsManager', () => {
  it('creates the eval set blob under the app prefix', async () => {
    const created = await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    expect(created.evalSetId).toBe(EVAL_SET_ID);
    expect(readBlob(BLOB_NAME)).toMatchObject({
      eval_set_id: EVAL_SET_ID,
      eval_cases: [],
    });
    expect(fakeStorage.bucket(BUCKET).blobs.get(BLOB_NAME)?.contentType).toBe(
      'application/json',
    );
  });

  it('refuses to create an eval set twice', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    await expect(
      manager.createEvalSet(APP_NAME, EVAL_SET_ID),
    ).rejects.toThrowError(
      new AlreadyExistsError(
        `EvalSet ${EVAL_SET_ID} already exists for app ${APP_NAME}.`,
      ),
    );
  });

  it('refuses an eval set id that is not alphanumeric', async () => {
    await expect(manager.createEvalSet(APP_NAME, 'not ok')).rejects.toThrow(
      InputValidationError,
    );
  });

  it('reports no eval set when the blob is absent', async () => {
    expect(await manager.getEvalSet(APP_NAME, EVAL_SET_ID)).toBeUndefined();
    expect(
      await manager.getEvalCase(APP_NAME, EVAL_SET_ID, 'lights_on'),
    ).toBeUndefined();
  });

  it('reads an eval set blob written by adk-python', async () => {
    writeBlob(BLOB_NAME, {
      eval_set_id: EVAL_SET_ID,
      creation_timestamp: 12.5,
      eval_cases: [
        {
          eval_id: 'lights_on',
          creation_timestamp: 12.5,
          conversation: [
            {user_content: {role: 'user', parts: [{text: 'Lights on'}]}},
          ],
        },
      ],
    });

    const evalCaseRead = await manager.getEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      'lights_on',
    );

    expect(evalCaseRead?.conversation?.[0].userContent.parts?.[0].text).toBe(
      'Lights on',
    );
  });

  it('lists only eval set blobs of that app, sorted', async () => {
    await manager.createEvalSet(APP_NAME, 'second');
    await manager.createEvalSet(APP_NAME, 'first');
    await manager.createEvalSet('other_app', 'third');
    writeBlob(`${APP_NAME}/evals/eval_sets/notes.txt`, {});

    expect(await manager.listEvalSets(APP_NAME)).toEqual(['first', 'second']);
  });

  it('adds, updates and deletes an eval case through the blob', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, evalCase('one', 'first'));
    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, evalCase('two', 'second'));
    await manager.updateEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      evalCase('one', 'updated'),
    );
    await manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, 'two');

    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet?.evalCases.map((known) => known.evalId)).toEqual(['one']);
    expect(
      evalSet?.evalCases[0].conversation?.[0].userContent.parts?.[0].text,
    ).toBe('updated');
  });

  it('reports an unknown eval set when editing a case', async () => {
    await expect(
      manager.addEvalCase(APP_NAME, 'ghost_set', evalCase('one', 'x')),
    ).rejects.toThrowError(
      new NotFoundError('Eval set `ghost_set` not found.'),
    );
  });

  it('refuses an app name or an eval set id that walks out of the prefix', async () => {
    await expect(manager.getEvalSet('../escape', EVAL_SET_ID)).rejects.toThrow(
      InputValidationError,
    );
    await expect(manager.getEvalSet(APP_NAME, '../escape')).rejects.toThrow(
      InputValidationError,
    );
  });

  it('reports a bucket that does not exist', async () => {
    const missing = new GcsEvalSetsManager('no-such-bucket');

    await expect(missing.getEvalSet(APP_NAME, EVAL_SET_ID)).rejects.toThrow(
      'Bucket `no-such-bucket` does not exist. Please create it before using ' +
        'the GcsEvalSetsManager.',
    );
  });
});
