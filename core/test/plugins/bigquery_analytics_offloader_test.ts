/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SaveOptions} from '@google-cloud/storage';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  buildObjectRef,
  fileExtension,
  GcsOffloader,
  objectPath,
} from '../../src/plugins/bigquery_analytics_offloader.js';

/** One recorded `file(...).save(...)` call. */
interface SavedObject {
  bucket: string;
  path: string;
  data: Buffer | string;
  options: SaveOptions;
}

const {StorageMock, saved, clientOptions, bucketCalls, failure} = vi.hoisted(
  () => {
    const saved: SavedObject[] = [];
    const clientOptions: unknown[] = [];
    const bucketCalls: string[] = [];
    const failure: {error?: Error} = {};

    class StorageMock {
      constructor(options: unknown) {
        clientOptions.push(options);
      }

      bucket(name: string) {
        bucketCalls.push(name);
        return {
          file: (path: string) => ({
            save: async (data: Buffer | string, options: SaveOptions) => {
              saved.push({bucket: name, path, data, options});
              if (failure.error !== undefined) {
                throw failure.error;
              }
            },
          }),
        };
      }
    }

    return {StorageMock, saved, clientOptions, bucketCalls, failure};
  },
);

vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

describe('GcsOffloader', () => {
  beforeEach(() => {
    saved.length = 0;
    clientOptions.length = 0;
    bucketCalls.length = 0;
    failure.error = undefined;
  });

  it('writes the object and returns its gs:// URI', async () => {
    const offloader = new GcsOffloader({
      projectId: 'my-project',
      bucketName: 'my-bucket',
    });

    const uri = await offloader.uploadContent(
      Buffer.from('bytes'),
      'image/png',
      '2026-01-02/trace/span_p0.png',
    );

    expect(uri).toBe('gs://my-bucket/2026-01-02/trace/span_p0.png');
    expect(clientOptions).toEqual([{projectId: 'my-project'}]);
    expect(saved).toHaveLength(1);
    expect(saved[0].bucket).toBe('my-bucket');
    expect(saved[0].path).toBe('2026-01-02/trace/span_p0.png');
    expect(saved[0].data).toEqual(Buffer.from('bytes'));
  });

  it('uploads create-only, so a name collision fails the upload', async () => {
    const offloader = new GcsOffloader({projectId: 'p', bucketName: 'b'});

    await offloader.uploadContent('text', 'text/plain', 'a.txt');

    expect(saved[0].options).toEqual({
      contentType: 'text/plain',
      preconditionOpts: {ifGenerationMatch: 0},
    });
  });

  it('resolves the bucket once and reuses it', async () => {
    const offloader = new GcsOffloader({projectId: 'p', bucketName: 'b'});

    await offloader.uploadContent('one', 'text/plain', 'a.txt');
    await offloader.uploadContent('two', 'text/plain', 'b.txt');

    expect(bucketCalls).toEqual(['b']);
    expect(clientOptions).toHaveLength(1);
    expect(saved.map((object) => object.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('propagates an upload failure to the caller', async () => {
    failure.error = new Error('precondition failed');
    const offloader = new GcsOffloader({projectId: 'p', bucketName: 'b'});

    await expect(
      offloader.uploadContent('text', 'text/plain', 'a.txt'),
    ).rejects.toThrow('precondition failed');
  });
});

describe('fileExtension', () => {
  it('maps a known MIME type, whatever its case', () => {
    expect(fileExtension('image/png')).toBe('.png');
    expect(fileExtension('IMAGE/JPEG')).toBe('.jpg');
    expect(fileExtension('text/plain')).toBe('.txt');
  });

  it('falls back to .bin for a MIME type it does not know', () => {
    expect(fileExtension('model/gltf-binary')).toBe('.bin');
    expect(fileExtension('')).toBe('.bin');
  });
});

describe('objectPath', () => {
  it('names an object by date, trace, span, parse and part', () => {
    const path = objectPath(
      {
        traceId: 'trace-1',
        spanId: 'span-1',
        parseUid: 'f'.repeat(32),
        contentOrdinal: 3,
        partIndex: 2,
      },
      '.png',
    );

    const date = new Date();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    expect(path).toBe(
      `${date.getFullYear()}-${month}-${day}/trace-1/span-1_${'f'.repeat(32)}_c3_p2.png`,
    );
  });
});

describe('buildObjectRef', () => {
  it('records the connection that authorizes the object', () => {
    expect(buildObjectRef('gs://b/a.png', 'image/png', 'us.conn')).toEqual({
      uri: 'gs://b/a.png',
      version: null,
      authorizer: 'us.conn',
      details: '{"gcs_metadata":{"content_type":"image/png"}}',
    });
  });

  it('records a null authorizer when no connection is configured', () => {
    expect(
      buildObjectRef('gs://b/a.txt', 'text/plain', undefined),
    ).toMatchObject({authorizer: null});
  });
});
