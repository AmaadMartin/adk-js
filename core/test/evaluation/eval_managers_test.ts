/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createGcsEvalManagersFromUri,
  GcsEvalSetResultsManager,
  GcsEvalSetsManager,
  InputValidationError,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {fakeStorage} from './fake_gcs_storage.js';

vi.mock('@google-cloud/storage', async () => {
  const {fakeStorage: storage} = await import('./fake_gcs_storage.js');
  return {Storage: vi.fn(() => storage)};
});

beforeEach(() => {
  fakeStorage.reset();
  fakeStorage.existingBuckets.add('my-bucket');
});

describe('createGcsEvalManagersFromUri', () => {
  it('builds both managers for a bucket URI', async () => {
    const managers = createGcsEvalManagersFromUri('gs://my-bucket');

    expect(managers.evalSetsManager).toBeInstanceOf(GcsEvalSetsManager);
    expect(managers.evalSetResultsManager).toBeInstanceOf(
      GcsEvalSetResultsManager,
    );
    // The bucket the managers reach is only observable through a call.
    await managers.evalSetsManager.createEvalSet('app', 'smoke');
    expect([...fakeStorage.bucket('my-bucket').blobs.keys()]).toEqual([
      'app/evals/eval_sets/smoke.evalset.json',
    ]);
  });

  it('ignores a path after the bucket name', async () => {
    const managers = createGcsEvalManagersFromUri('gs://my-bucket/some/path');

    await managers.evalSetsManager.createEvalSet('app', 'smoke');

    expect([...fakeStorage.bucket('my-bucket').blobs.keys()]).toEqual([
      'app/evals/eval_sets/smoke.evalset.json',
    ]);
  });

  it('refuses a URI of any other scheme', () => {
    expect(() =>
      createGcsEvalManagersFromUri('file:///tmp/evals'),
    ).toThrowError(
      new InputValidationError(
        'Unsupported evals storage URI: file:///tmp/evals. Supported URIs: ' +
          'gs://<bucket name>',
      ),
    );
  });
});
