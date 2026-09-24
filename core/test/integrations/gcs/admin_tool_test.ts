/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/integrations/gcs/test_gcs_admin_tool.py`.
 *
 * The reference patches `client.get_gcs_client`. This port patches
 * `@google-cloud/storage` instead, so the real `getGcsClient` runs and the
 * options it builds are covered too.
 *
 * `test_get_bucket` and `test_get_bucket_with_properties` read Python's
 * `bucket._properties`. Its Node counterpart is `bucket.getMetadata()`, so
 * the fake reports the same objects through that call.
 */

import type {BucketMetadata} from '@google-cloud/storage';
// Not part of the package barrel: the toolset is the public surface, and
// it is what calls these.
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createBucket,
  deleteBucket,
  getBucket,
  listBuckets,
  updateBucket,
} from '../../../src/integrations/gcs/admin_tool.js';

import {gcsFakeHooks, resetGcsFakes, storageInstances} from './gcs_fakes.js';

vi.mock('@google-cloud/storage', async () => ({
  Storage: (await import('./gcs_fakes.js')).FakeStorage,
}));

const credentials = new OAuth2Client();

describe('gcs admin tools', () => {
  beforeEach(() => {
    resetGcsFakes();
  });

  it('test_list_buckets', async () => {
    gcsFakeHooks.onCreate = (storage) => {
      storage.bucketNames = ['test-bucket'];
      storage.nextPageToken = 'ignored-without-a-page-size';
    };

    const result = await listBuckets({projectId: 'test-project', credentials});

    expect(result).toEqual({status: 'SUCCESS', results: ['test-bucket']});
    expect(storageInstances[0].getBucketsRequests).toEqual([{}]);
  });

  it('test_list_buckets_pagination', async () => {
    gcsFakeHooks.onCreate = (storage) => {
      storage.bucketNames = ['test-bucket'];
      storage.nextPageToken = 'next-page-token';
    };

    const result = await listBuckets({
      projectId: 'test-project',
      credentials,
      pageSize: 1,
      pageToken: 'token',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: ['test-bucket'],
      next_page_token: 'next-page-token',
    });
    expect(storageInstances[0].getBucketsRequests).toEqual([
      {maxResults: 1, autoPaginate: false, pageToken: 'token'},
    ]);
  });

  it('test_create_bucket', async () => {
    const result = await createBucket({
      projectId: 'test-project',
      bucketName: 'test-bucket',
      credentials,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket created successfully.',
    });
    expect(storageInstances[0].createBucketRequests).toEqual([
      {name: 'test-bucket', metadata: {}},
    ]);
  });

  it('test_update_bucket', async () => {
    const result = await updateBucket({
      bucketName: 'test-bucket',
      credentials,
      versioningEnabled: true,
      uniformBucketLevelAccessEnabled: true,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket updated successfully.',
    });
    expect(storageInstances[0].bucket('test-bucket').patches).toEqual([
      {
        versioning: {enabled: true},
        iamConfiguration: {uniformBucketLevelAccess: {enabled: true}},
      },
    ]);
  });

  it('test_delete_bucket', async () => {
    const result = await deleteBucket({
      bucketName: 'test-bucket',
      credentials,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket deleted successfully.',
    });
    expect(storageInstances[0].bucket('test-bucket').deleteCalls).toBe(1);
  });

  it('test_get_bucket', async () => {
    const properties: BucketMetadata = {
      id: 'test-bucket-id',
      name: 'test-bucket',
      location: 'US',
      storageClass: 'STANDARD',
      timeCreated: '2024-01-01',
      updated: '2024-01-02',
      labels: {env: 'test'},
    };
    gcsFakeHooks.onCreate = (storage) => {
      storage.metadata.set('test-bucket', properties);
    };

    const result = await getBucket({bucketName: 'test-bucket', credentials});

    expect(result).toEqual({status: 'SUCCESS', results: properties});
  });

  it('test_get_bucket_with_properties', async () => {
    const properties: BucketMetadata = {
      kind: 'storage#bucket',
      id: 'test-bucket-id',
      name: 'test-bucket',
      location: 'US',
      storageClass: 'STANDARD',
      timeCreated: '2024-01-01',
      updated: '2024-01-02',
      labels: {env: 'test'},
      locationType: 'region',
      etag: 'etag-val',
      metageneration: '2',
      versioning: {enabled: true},
      iamConfiguration: {uniformBucketLevelAccess: {enabled: true}},
    };
    gcsFakeHooks.onCreate = (storage) => {
      storage.metadata.set('test-bucket', properties);
    };

    const result = await getBucket({bucketName: 'test-bucket', credentials});

    expect(result).toEqual({status: 'SUCCESS', results: properties});
  });
});
