/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `createGcsClient` only. `getGcsClient`, the factory the admin toolset calls,
 * is covered by `admin_client_test.ts`: the two suites script a different
 * stand-in for `@google-cloud/storage`, and one file installs one `vi.mock`.
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/gcs/test_client.py`, at upstream `main`.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  createGcsClient,
  GCS_TOOL_USER_AGENT,
} from '../../../src/integrations/gcs/client.js';
import {GCS_DEFAULT_SCOPE} from '../../../src/integrations/gcs/gcs_credentials.js';

const {FakeStorage, fakeGcs} = await vi.hoisted(
  async () => import('./fake_gcs_storage.js'),
);

vi.mock('@google-cloud/storage', () => ({Storage: FakeStorage}));

describe('createGcsClient', () => {
  beforeEach(() => {
    fakeGcs.reset();
  });

  it('test_get_gcs_client', async () => {
    await createGcsClient({keyFilename: 'key.json'}, 'test-project');

    expect(fakeGcs.clientOptions).toEqual([
      {
        keyFilename: 'key.json',
        scopes: GCS_DEFAULT_SCOPE,
        userAgent: GCS_TOOL_USER_AGENT,
        projectId: 'test-project',
      },
    ]);
  });

  it('omits projectId when no project is given', async () => {
    await createGcsClient();

    expect(fakeGcs.clientOptions).toHaveLength(1);
    expect(fakeGcs.clientOptions[0]).not.toHaveProperty('projectId');
  });

  it('keeps a caller-supplied scope instead of the default', async () => {
    const scopes = ['https://www.googleapis.com/auth/devstorage.read_only'];

    await createGcsClient({scopes});

    expect(fakeGcs.clientOptions[0]).toMatchObject({scopes});
  });

  it('test_get_gcs_client_is_never_shared_between_credentials', async () => {
    for (let i = 0; i < 200; i++) {
      await createGcsClient({keyFilename: `key-${i}.json`});
    }

    expect(fakeGcs.clients).toHaveLength(200);
    expect(new Set(fakeGcs.clients).size).toBe(200);
    expect(fakeGcs.clientOptions.map((o) => o['keyFilename'])).toEqual(
      Array.from({length: 200}, (_, i) => `key-${i}.json`),
    );
  });

  it('test_get_gcs_client_returns_a_new_client_per_call', async () => {
    const first = await createGcsClient(undefined, 'test-project');
    const second = await createGcsClient(undefined, 'test-project');

    expect(first).not.toBe(second);
    expect(fakeGcs.clients).toHaveLength(2);
  });
});
