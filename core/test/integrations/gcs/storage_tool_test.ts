/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/gcs/test_gcs_storage_tool.py`, at upstream
 * `main`.
 */

import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {Storage} from '@google-cloud/storage';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createGcsClient} from '../../../src/integrations/gcs/client.js';
import {
  createObject,
  deleteObjects,
  getObjectData,
  getObjectMetadata,
  listObjects,
} from '../../../src/integrations/gcs/storage_tool.js';
import {FakeApiError} from './fake_gcs_storage.js';

const {FakeStorage, fakeGcs} = await vi.hoisted(
  async () => import('./fake_gcs_storage.js'),
);

vi.mock('@google-cloud/storage', () => ({Storage: FakeStorage}));

const BUCKET = 'test-bucket';

describe('Cloud Storage tools', () => {
  let client: Storage;
  let workDir: string;

  beforeEach(async () => {
    fakeGcs.reset();
    client = await createGcsClient();
    workDir = mkdtempSync(join(tmpdir(), 'adk-gcs-tool-test-'));
  });

  afterEach(() => {
    rmSync(workDir, {recursive: true, force: true});
  });

  it('test_list_objects', async () => {
    fakeGcs.bucket(BUCKET).put('test-object', Buffer.from('content'));

    const result = await listObjects(client, {bucket_name: BUCKET});

    expect(result).toEqual({status: 'SUCCESS', results: ['test-object']});
  });

  it('test_list_objects_pagination', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.put('a-object', Buffer.from('a'));
    bucket.put('b-object', Buffer.from('b'));
    bucket.put('c-object', Buffer.from('c'));

    const result = await listObjects(client, {
      bucket_name: BUCKET,
      page_size: 1,
      page_token: 'b-object',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: ['b-object'],
      next_page_token: 'c-object',
    });
    expect(bucket.getFilesQueries).toEqual([
      {maxResults: 1, pageToken: 'b-object', autoPaginate: false},
    ]);
  });

  it('walks every page and reports no token when page_size is omitted', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.put('logs/a', Buffer.from('a'));
    bucket.put('logs/b', Buffer.from('b'));
    bucket.put('other', Buffer.from('c'));

    const result = await listObjects(client, {
      bucket_name: BUCKET,
      prefix: 'logs/',
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['logs/a', 'logs/b']});
    expect(bucket.getFilesQueries).toEqual([{prefix: 'logs/'}]);
  });

  it('omits next_page_token on the last page', async () => {
    fakeGcs.bucket(BUCKET).put('only-object', Buffer.from('a'));

    const result = await listObjects(client, {
      bucket_name: BUCKET,
      page_size: 5,
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['only-object']});
  });

  it('reports a failed listing as an error record', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.failure = new FakeApiError('backend unavailable', 503);

    const result = await listObjects(client, {bucket_name: BUCKET});

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'backend unavailable (HTTP 503)',
    });
  });

  it('test_get_object_metadata', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.put('test-object', Buffer.from('content'));

    const result = await getObjectMetadata(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
      generation: 1,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: {
        kind: 'storage#object',
        id: 'test-bucket/test-object/1',
        name: 'test-object',
        bucket: BUCKET,
        size: '7',
      },
    });
    expect(bucket.fileCalls).toEqual([{name: 'test-object', generation: 1}]);
  });

  it('test_get_object_metadata_not_found', async () => {
    const result = await getObjectMetadata(client, {
      bucket_name: BUCKET,
      object_name: 'non-existent',
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Object non-existent not found in bucket test-bucket',
    });
    expect(fakeGcs.bucket(BUCKET).fileCalls).toEqual([
      {name: 'non-existent', generation: undefined},
    ]);
  });

  it('reports a denied read as itself, not as a missing object', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.put('test-object', Buffer.from('content'));
    bucket.failure = new FakeApiError('permission denied', 403);

    const result = await getObjectMetadata(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'permission denied (HTTP 403)',
    });
  });

  it('test_create_object', async () => {
    const result = await createObject(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
      data: 'data',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Object test-object created successfully in bucket test-bucket.',
    });
    expect(
      fakeGcs.bucket(BUCKET).objects.get('test-object')?.data.toString(),
    ).toBe('data');
  });

  it('test_create_object_from_file', async () => {
    const sourceFilePath = join(workDir, 'file.txt');
    writeFileSync(sourceFilePath, 'from disk');

    const result = await createObject(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
      source_file_path: sourceFilePath,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Object test-object created successfully in bucket test-bucket.',
    });
    expect(fakeGcs.bucket(BUCKET).uploads).toEqual([
      {path: sourceFilePath, destination: 'test-object'},
    ]);
    expect(
      fakeGcs.bucket(BUCKET).objects.get('test-object')?.data.toString(),
    ).toBe('from disk');
  });

  it('prefers source_file_path over data when both are given', async () => {
    const sourceFilePath = join(workDir, 'file.txt');
    writeFileSync(sourceFilePath, 'from disk');

    await createObject(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
      data: 'inline',
      source_file_path: sourceFilePath,
    });

    expect(
      fakeGcs.bucket(BUCKET).objects.get('test-object')?.data.toString(),
    ).toBe('from disk');
  });

  it('test_create_object_no_data', async () => {
    const result = await createObject(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: "Either 'data' or 'source_file_path' must be provided.",
    });
    expect(fakeGcs.bucket(BUCKET).objects.size).toBe(0);
  });

  it('reports an upload failure as an error record', async () => {
    const result = await createObject(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
      source_file_path: join(workDir, 'missing.txt'),
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect(result).toHaveProperty(
      'error_details',
      expect.stringContaining('ENOENT'),
    );
  });

  it('test_get_object_data', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.put('test-object', Buffer.from('content'));

    const result = await getObjectData(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
      generation: 1,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'content',
      encoding: 'text',
    });
    expect(bucket.fileCalls).toEqual([{name: 'test-object', generation: 1}]);
  });

  it('test_get_object_data_no_generation', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.put('test-object', Buffer.from([0xff, 0xff]));

    const result = await getObjectData(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: '//8=',
      encoding: 'base64',
    });
    expect(bucket.fileCalls).toEqual([
      {name: 'test-object', generation: undefined},
    ]);
  });

  it('test_get_object_data_to_file', async () => {
    fakeGcs.bucket(BUCKET).put('test-object', Buffer.from('downloaded'));
    const destinationFilePath = join(workDir, 'download.txt');

    const result = await getObjectData(client, {
      bucket_name: BUCKET,
      object_name: 'test-object',
      destination_file_path: destinationFilePath,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: `Object test-object downloaded successfully to ${destinationFilePath}.`,
    });
    expect(readFileSync(destinationFilePath, 'utf8')).toBe('downloaded');
  });

  it('reports a missing object on download as not found', async () => {
    const result = await getObjectData(client, {
      bucket_name: BUCKET,
      object_name: 'non-existent',
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Object non-existent not found in bucket test-bucket',
    });
  });

  it('test_delete_objects', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.put('test-object', Buffer.from('a'));
    bucket.put('kept-object', Buffer.from('b'));

    const result = await deleteObjects(client, {
      bucket_name: BUCKET,
      object_names: ['test-object'],
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results:
        'Objects test-object deleted successfully from bucket test-bucket.',
    });
    expect([...bucket.objects.keys()]).toEqual(['kept-object']);
  });

  it('reports a failed delete as an error record', async () => {
    const result = await deleteObjects(client, {
      bucket_name: BUCKET,
      object_names: ['non-existent'],
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect(result).toHaveProperty(
      'error_details',
      expect.stringContaining('No such object: non-existent'),
    );
  });
});
