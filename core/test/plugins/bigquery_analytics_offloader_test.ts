/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SaveOptions} from '@google-cloud/storage';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  GcsOffloader,
  OffloadBucket,
  OffloadStorage,
} from '../../src/plugins/bigquery_analytics_offloader.js';

/** One recorded `file(...).save(...)` call. */
interface SavedObject {
  bucket: string;
  path: string;
  data: Buffer | string;
  options: SaveOptions;
}

const {StorageMock, peerCalls} = vi.hoisted(() => {
  const peerCalls: unknown[] = [];

  class StorageMock {
    constructor(options: unknown) {
      peerCalls.push(options);
    }

    bucket(name: string): OffloadBucket {
      return {
        file: (path: string) => ({
          save: async () => {
            peerCalls.push({name, path});
          },
        }),
      };
    }
  }

  return {StorageMock, peerCalls};
});

vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

/** A client that records every save instead of reaching Cloud Storage. */
function fakeStorage(
  saved: SavedObject[],
  saveError?: Error,
): {storage: OffloadStorage; bucketCalls: string[]} {
  const bucketCalls: string[] = [];
  const storage: OffloadStorage = {
    bucket(name: string): OffloadBucket {
      bucketCalls.push(name);
      return {
        file: (path: string) => ({
          save: async (data: Buffer | string, options: SaveOptions) => {
            saved.push({bucket: name, path, data, options});
            if (saveError !== undefined) {
              throw saveError;
            }
          },
        }),
      };
    },
  };
  return {storage, bucketCalls};
}

describe('GcsOffloader', () => {
  beforeEach(() => {
    peerCalls.length = 0;
  });

  it('writes the object and returns its gs:// URI', async () => {
    const saved: SavedObject[] = [];
    const offloader = new GcsOffloader({
      projectId: 'p',
      bucketName: 'my-bucket',
      storage: fakeStorage(saved).storage,
    });

    const uri = await offloader.uploadContent(
      Buffer.from('bytes'),
      'image/png',
      '2026-01-02/trace/span_p0.png',
    );

    expect(uri).toBe('gs://my-bucket/2026-01-02/trace/span_p0.png');
    expect(saved).toHaveLength(1);
    expect(saved[0].bucket).toBe('my-bucket');
    expect(saved[0].path).toBe('2026-01-02/trace/span_p0.png');
    expect(saved[0].data).toEqual(Buffer.from('bytes'));
  });

  it('uploads create-only, so a name collision fails the upload', async () => {
    const saved: SavedObject[] = [];
    const offloader = new GcsOffloader({
      projectId: 'p',
      bucketName: 'b',
      storage: fakeStorage(saved).storage,
    });

    await offloader.uploadContent('text', 'text/plain', 'a.txt');

    expect(saved[0].options).toEqual({
      contentType: 'text/plain',
      preconditionOpts: {ifGenerationMatch: 0},
    });
  });

  it('resolves the bucket once and reuses it', async () => {
    const saved: SavedObject[] = [];
    const {storage, bucketCalls} = fakeStorage(saved);
    const offloader = new GcsOffloader({
      projectId: 'p',
      bucketName: 'b',
      storage,
    });

    await offloader.uploadContent('one', 'text/plain', 'a.txt');
    await offloader.uploadContent('two', 'text/plain', 'b.txt');

    expect(bucketCalls).toEqual(['b']);
    expect(saved.map((object) => object.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('propagates an upload failure to the caller', async () => {
    const saved: SavedObject[] = [];
    const offloader = new GcsOffloader({
      projectId: 'p',
      bucketName: 'b',
      storage: fakeStorage(saved, new Error('precondition failed')).storage,
    });

    await expect(
      offloader.uploadContent('text', 'text/plain', 'a.txt'),
    ).rejects.toThrow('precondition failed');
  });

  it('builds a client from the peer package when none is injected', async () => {
    const offloader = new GcsOffloader({
      projectId: 'my-project',
      bucketName: 'peer-bucket',
    });

    const uri = await offloader.uploadContent('text', 'text/plain', 'a.txt');

    expect(uri).toBe('gs://peer-bucket/a.txt');
    expect(peerCalls).toEqual([
      {projectId: 'my-project'},
      {name: 'peer-bucket', path: 'a.txt'},
    ]);
  });
});
