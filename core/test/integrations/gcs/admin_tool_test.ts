/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createBucket,
  deleteBucket,
  getBucket,
  listBuckets,
  updateBucket,
} from '../../../src/integrations/gcs/admin_tool.js';

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  bucketNames: [] as string[],
  getBuckets: vi.fn(),
  createBucket: vi.fn(),
  getMetadata: vi.fn(),
  setMetadata: vi.fn(),
  bucketDelete: vi.fn(),
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    getBuckets = mocks.getBuckets;
    createBucket = mocks.createBucket;

    constructor(options: unknown) {
      mocks.clientOptions.push(options);
    }

    bucket(name: string) {
      mocks.bucketNames.push(name);
      return {
        getMetadata: mocks.getMetadata,
        setMetadata: mocks.setMetadata,
        delete: mocks.bucketDelete,
      };
    }
  },
}));

beforeEach(() => {
  mocks.clientOptions.length = 0;
  mocks.bucketNames.length = 0;
  // Reset, not clear: `updateBucket` reads the bucket, so a rejection left
  // behind by an earlier test would decide a later one.
  vi.resetAllMocks();
});

describe('listBuckets', () => {
  it('returns every bucket name and no page token when no page size is given', async () => {
    mocks.getBuckets.mockResolvedValue([[{name: 'test-bucket'}]]);

    const result = await listBuckets({project_id: 'test-project'});

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: ['test-bucket'],
    });
    expect(mocks.getBuckets).toHaveBeenCalledWith({});
  });

  it('tags the client with the ADK user agent and the requested project', async () => {
    mocks.getBuckets.mockResolvedValue([[]]);

    await listBuckets({project_id: 'test-project'}, {apiEndpoint: 'endpoint'});

    expect(mocks.clientOptions).toStrictEqual([
      {
        userAgent: `adk-gcs-tool google-adk/${version}`,
        apiEndpoint: 'endpoint',
        projectId: 'test-project',
      },
    ]);
  });

  it('requests one page and returns the token of the next one', async () => {
    mocks.getBuckets.mockResolvedValue([
      [{name: 'test-bucket'}],
      {pageToken: 'next-page-token'},
    ]);

    const result = await listBuckets({
      project_id: 'test-project',
      page_size: 1,
      page_token: 'token',
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: ['test-bucket'],
      next_page_token: 'next-page-token',
    });
    expect(mocks.getBuckets).toHaveBeenCalledWith({
      maxResults: 1,
      pageToken: 'token',
      autoPaginate: false,
    });
  });

  it('omits the token when the client reports no further page', async () => {
    mocks.getBuckets.mockResolvedValue([[{name: 'test-bucket'}], null]);

    const result = await listBuckets({
      project_id: 'test-project',
      page_size: 1,
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: ['test-bucket'],
    });
  });

  it('returns no token for a page token without a page size', async () => {
    // The client auto-paginates here and hands the request query back in
    // place of a next-page one, so the caller's own token must not be echoed.
    mocks.getBuckets.mockResolvedValue([
      [{name: 'test-bucket'}],
      {pageToken: 'token'},
    ]);

    const result = await listBuckets({
      project_id: 'test-project',
      page_token: 'token',
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: ['test-bucket'],
    });
    expect(mocks.getBuckets).toHaveBeenCalledWith({pageToken: 'token'});
  });

  it('reports the failure instead of throwing', async () => {
    mocks.getBuckets.mockRejectedValue(new Error('list failed'));

    const result = await listBuckets({project_id: 'test-project'});

    expect(result).toStrictEqual({
      status: 'ERROR',
      error_details: 'list failed',
    });
  });
});

describe('getBucket', () => {
  it('passes the bucket resource through unmodified', async () => {
    const metadata = {
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
      metageneration: 2,
      versioning: {enabled: true},
      iamConfiguration: {uniformBucketLevelAccess: {enabled: true}},
    };
    mocks.getMetadata.mockResolvedValue([metadata]);

    const result = await getBucket({bucket_name: 'test-bucket'});

    expect(result).toStrictEqual({status: 'SUCCESS', results: metadata});
    expect(mocks.bucketNames).toStrictEqual(['test-bucket']);
  });

  it('reports the failure instead of throwing', async () => {
    mocks.getMetadata.mockRejectedValue(new Error('bucket not found'));

    const result = await getBucket({bucket_name: 'test-bucket'});

    expect(result).toStrictEqual({
      status: 'ERROR',
      error_details: 'bucket not found',
    });
  });
});

describe('createBucket', () => {
  it('sends no location when none is given', async () => {
    mocks.createBucket.mockResolvedValue([{name: 'test-bucket'}]);

    const result = await createBucket({
      project_id: 'test-project',
      bucket_name: 'test-bucket',
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket created successfully.',
    });
    expect(mocks.createBucket).toHaveBeenCalledWith('test-bucket', {});
  });

  it('forwards the location when one is given', async () => {
    mocks.createBucket.mockResolvedValue([{name: 'test-bucket'}]);

    await createBucket({
      project_id: 'test-project',
      bucket_name: 'test-bucket',
      location: 'europe-west1',
    });

    expect(mocks.createBucket).toHaveBeenCalledWith('test-bucket', {
      location: 'europe-west1',
    });
  });

  it('reports the failure instead of throwing', async () => {
    mocks.createBucket.mockRejectedValue(new Error('name already taken'));

    const result = await createBucket({
      project_id: 'test-project',
      bucket_name: 'test-bucket',
    });

    expect(result).toStrictEqual({
      status: 'ERROR',
      error_details: 'name already taken',
    });
  });
});

describe('updateBucket', () => {
  it('patches both fields in one request', async () => {
    mocks.setMetadata.mockResolvedValue([{}]);

    const result = await updateBucket({
      bucket_name: 'test-bucket',
      versioning_enabled: true,
      uniform_bucket_level_access_enabled: true,
    });

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket updated successfully.',
    });
    expect(mocks.setMetadata).toHaveBeenCalledOnce();
    expect(mocks.setMetadata).toHaveBeenCalledWith({
      versioning: {enabled: true},
      iamConfiguration: {uniformBucketLevelAccess: {enabled: true}},
    });
  });

  it('patches only the field that was supplied', async () => {
    mocks.setMetadata.mockResolvedValue([{}]);

    await updateBucket({
      bucket_name: 'test-bucket',
      versioning_enabled: false,
    });

    expect(mocks.setMetadata).toHaveBeenCalledWith({
      versioning: {enabled: false},
    });
  });

  it('reads the bucket and patches nothing when neither field is supplied', async () => {
    mocks.getMetadata.mockResolvedValue([{name: 'test-bucket'}]);

    const result = await updateBucket({bucket_name: 'test-bucket'});

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket updated successfully.',
    });
    expect(mocks.getMetadata).toHaveBeenCalledOnce();
    expect(mocks.setMetadata).not.toHaveBeenCalled();
  });

  it('reports the failure when the bucket cannot be read and no field is supplied', async () => {
    mocks.getMetadata.mockRejectedValue(new Error('bucket not found'));

    const result = await updateBucket({bucket_name: 'test-bucket'});

    expect(result).toStrictEqual({
      status: 'ERROR',
      error_details: 'bucket not found',
    });
    expect(mocks.setMetadata).not.toHaveBeenCalled();
  });

  it('reports the failure instead of throwing', async () => {
    mocks.setMetadata.mockRejectedValue(new Error('permission denied'));

    const result = await updateBucket({
      bucket_name: 'test-bucket',
      versioning_enabled: true,
    });

    expect(result).toStrictEqual({
      status: 'ERROR',
      error_details: 'permission denied',
    });
  });
});

describe('deleteBucket', () => {
  it('deletes the named bucket once', async () => {
    mocks.bucketDelete.mockResolvedValue([{}]);

    const result = await deleteBucket({bucket_name: 'test-bucket'});

    expect(result).toStrictEqual({
      status: 'SUCCESS',
      results: 'Bucket test-bucket deleted successfully.',
    });
    expect(mocks.bucketDelete).toHaveBeenCalledOnce();
    expect(mocks.bucketNames).toStrictEqual(['test-bucket']);
  });

  it('reports the failure instead of throwing', async () => {
    mocks.bucketDelete.mockRejectedValue(new Error('bucket is not empty'));

    const result = await deleteBucket({bucket_name: 'test-bucket'});

    expect(result).toStrictEqual({
      status: 'ERROR',
      error_details: 'bucket is not empty',
    });
  });
});

describe('bucket name validation', () => {
  // The client joins a bucket name into the request path unescaped, so this
  // name reaches `/victim-bucket/o/secret.txt` on the storage host.
  const traversal = '../../../victim-bucket/o/secret.txt';

  it('reports an error and builds no client for a traversing name', async () => {
    const result = await getBucket({bucket_name: traversal});

    expect(result).toStrictEqual({
      status: 'ERROR',
      error_details: expect.stringContaining(
        `Invalid bucket name '${traversal}'`,
      ),
    });
    expect(mocks.clientOptions).toStrictEqual([]);
    expect(mocks.bucketNames).toStrictEqual([]);
  });

  it('deletes nothing for a traversing name', async () => {
    const result = await deleteBucket({bucket_name: traversal});

    expect(result.status).toBe('ERROR');
    expect(mocks.bucketDelete).not.toHaveBeenCalled();
  });

  it('reads and patches nothing for a traversing name', async () => {
    const result = await updateBucket({
      bucket_name: traversal,
      versioning_enabled: true,
    });

    expect(result.status).toBe('ERROR');
    expect(mocks.getMetadata).not.toHaveBeenCalled();
    expect(mocks.setMetadata).not.toHaveBeenCalled();
  });

  it('creates nothing for a traversing name', async () => {
    const result = await createBucket({
      project_id: 'test-project',
      bucket_name: traversal,
    });

    expect(result.status).toBe('ERROR');
    expect(mocks.createBucket).not.toHaveBeenCalled();
  });

  it.each([
    ['a query that redirects the read', 'bucket?alt=media'],
    ['a fragment', 'bucket#frag'],
    ['an escaped separator', 'bucket%2fobject'],
    ['the parent directory', '..'],
    ['a leading dot', '.bucket'],
    ['an uppercase letter', 'Bucket'],
    ['a space', 'my bucket'],
    ['an empty name', ''],
  ])('rejects %s', async (_description, bucketName) => {
    const result = await getBucket({bucket_name: bucketName});

    expect(result.status).toBe('ERROR');
    expect(mocks.bucketNames).toStrictEqual([]);
  });

  it.each(['b', '0', 'my-bucket', 'my.bucket_1-x'])(
    'accepts %s',
    async (bucketName) => {
      mocks.getMetadata.mockResolvedValue([{name: bucketName}]);

      const result = await getBucket({bucket_name: bucketName});

      expect(result.status).toBe('SUCCESS');
      expect(mocks.bucketNames).toStrictEqual([bucketName]);
    },
  );
});
