/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases the adk-python reference tests do not cover: the error path of each
 * of the five tools, and the paging and patching branches.
 */

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

/** Makes the named client method reject, as the real SDK does on a failure. */
function failOn(method: string, message: string): void {
  gcsFakeHooks.onCreate = (storage) => {
    storage.failures.set(method, new Error(message));
  };
}

describe('gcs admin tools error paths', () => {
  beforeEach(() => {
    resetGcsFakes();
  });

  it('reports an error instead of throwing when listing fails', async () => {
    failOn('getBuckets', 'listing denied');

    const result = await listBuckets({projectId: 'p', credentials});

    expect(result).toEqual({status: 'ERROR', error_details: 'listing denied'});
  });

  it('reports an error instead of throwing when reading fails', async () => {
    failOn('getMetadata', 'bucket not found');

    const result = await getBucket({bucketName: 'b', credentials});

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'bucket not found',
    });
  });

  it('reports an error instead of throwing when creating fails', async () => {
    failOn('createBucket', 'name already taken');

    const result = await createBucket({
      projectId: 'p',
      bucketName: 'b',
      credentials,
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'name already taken',
    });
  });

  it('reports an error instead of throwing when patching fails', async () => {
    failOn('setMetadata', 'patch denied');

    const result = await updateBucket({
      bucketName: 'b',
      credentials,
      versioningEnabled: true,
    });

    expect(result).toEqual({status: 'ERROR', error_details: 'patch denied'});
  });

  it('reports an error instead of throwing when deleting fails', async () => {
    failOn('delete', 'bucket not empty');

    const result = await deleteBucket({bucketName: 'b', credentials});

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'bucket not empty',
    });
  });
});

describe('listBuckets paging', () => {
  beforeEach(() => {
    resetGcsFakes();
  });

  it('omits next_page_token when no page size was asked for', async () => {
    gcsFakeHooks.onCreate = (storage) => {
      storage.bucketNames = ['one', 'two'];
      storage.nextPageToken = 'a-token-the-caller-cannot-use';
    };

    const result = await listBuckets({projectId: 'p', credentials});

    expect(result).toEqual({status: 'SUCCESS', results: ['one', 'two']});
    expect(result).not.toHaveProperty('next_page_token');
  });

  it('omits next_page_token on the last page', async () => {
    gcsFakeHooks.onCreate = (storage) => {
      storage.bucketNames = ['one'];
    };

    const result = await listBuckets({
      projectId: 'p',
      credentials,
      pageSize: 10,
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['one']});
    expect(result).not.toHaveProperty('next_page_token');
  });

  it('omits the page token from the request when the caller gave none', async () => {
    gcsFakeHooks.onCreate = (storage) => {
      storage.bucketNames = [];
    };

    await listBuckets({projectId: 'p', credentials, pageSize: 5});

    expect(storageInstances[0].getBucketsRequests).toEqual([
      {maxResults: 5, autoPaginate: false},
    ]);
  });
});

describe('updateBucket patching', () => {
  beforeEach(() => {
    resetGcsFakes();
  });

  it('makes no patch call when neither flag was supplied', async () => {
    const result = await updateBucket({bucketName: 'b', credentials});

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket b updated successfully.',
    });
    const bucket = storageInstances[0].bucket('b');
    expect(bucket.getMetadataCalls).toBe(1);
    expect(bucket.patches).toEqual([]);
  });

  it('patches versioning alone when only that flag was supplied', async () => {
    await updateBucket({
      bucketName: 'b',
      credentials,
      versioningEnabled: false,
    });

    expect(storageInstances[0].bucket('b').patches).toEqual([
      {versioning: {enabled: false}},
    ]);
  });

  it('patches uniform access alone when only that flag was supplied', async () => {
    await updateBucket({
      bucketName: 'b',
      credentials,
      uniformBucketLevelAccessEnabled: false,
    });

    expect(storageInstances[0].bucket('b').patches).toEqual([
      {iamConfiguration: {uniformBucketLevelAccess: {enabled: false}}},
    ]);
  });
});

describe('createBucket location', () => {
  beforeEach(() => {
    resetGcsFakes();
  });

  it('forwards the location when the caller gave one', async () => {
    await createBucket({
      projectId: 'p',
      bucketName: 'b',
      credentials,
      location: 'europe-west1',
    });

    expect(storageInstances[0].createBucketRequests).toEqual([
      {name: 'b', metadata: {location: 'europe-west1'}},
    ]);
  });
});
