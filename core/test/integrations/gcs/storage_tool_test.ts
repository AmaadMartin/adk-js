/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, GcsToolset, GcsToolStatus} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createToolContext, getTool, READ_WRITE} from './test_utils.js';

const {StorageMock, fakes} = vi.hoisted(() => {
  const file = {
    getMetadata: vi.fn(),
    download: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
  };
  const bucket = {
    getMetadata: vi.fn(),
    getFiles: vi.fn(),
    file: vi.fn(() => file),
    upload: vi.fn(),
  };
  const storage = {bucket: vi.fn(() => bucket)};
  return {StorageMock: vi.fn(() => storage), fakes: {file, bucket, storage}};
});

vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

const OBJECT_METADATA = {
  kind: 'storage#object',
  name: 'test-object',
  bucket: 'test-bucket',
  size: '1024',
  contentType: 'text/plain',
};

/** An error shaped like the one `@google-cloud/storage` raises on a 404. */
function apiError(code: number, message: string): Error & {code: number} {
  return Object.assign(new Error(message), {code});
}

describe('GCS storage tools', () => {
  let toolset: GcsToolset;
  let toolContext: Context;

  beforeEach(async () => {
    vi.clearAllMocks();
    fakes.bucket.getMetadata.mockResolvedValue([{name: 'test-bucket'}]);
    fakes.bucket.getFiles.mockResolvedValue([[]]);
    fakes.bucket.upload.mockResolvedValue(undefined);
    fakes.file.getMetadata.mockResolvedValue([OBJECT_METADATA]);
    fakes.file.download.mockResolvedValue([Buffer.from('content')]);
    fakes.file.save.mockResolvedValue(undefined);
    fakes.file.delete.mockResolvedValue(undefined);

    toolset = new GcsToolset({toolSettings: READ_WRITE});
    toolContext = await createToolContext();
  });

  describe('gcs_get_bucket', () => {
    it('returns the bucket metadata', async () => {
      const metadata = {
        kind: 'storage#bucket',
        name: 'test-bucket',
        location: 'US',
        versioning: {enabled: true},
      };
      fakes.bucket.getMetadata.mockResolvedValue([metadata]);
      const tool = await getTool(toolset, 'gcs_get_bucket');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: metadata,
      });
      expect(fakes.storage.bucket).toHaveBeenCalledWith('test-bucket');
    });

    it('reports a failed request as an error result', async () => {
      fakes.bucket.getMetadata.mockRejectedValue(new Error('boom'));
      const tool = await getTool(toolset, 'gcs_get_bucket');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'boom',
      });
    });
  });

  describe('gcs_list_objects', () => {
    it('lists object names without pagination', async () => {
      fakes.bucket.getFiles.mockResolvedValue([[{name: 'test-object'}]]);
      const tool = await getTool(toolset, 'gcs_list_objects');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: ['test-object'],
      });
      expect(fakes.bucket.getFiles).toHaveBeenCalledWith({});
    });

    it('passes the prefix through', async () => {
      const tool = await getTool(toolset, 'gcs_list_objects');

      await tool.runAsync({
        args: {bucket_name: 'test-bucket', prefix: 'logs/'},
        toolContext,
      });

      expect(fakes.bucket.getFiles).toHaveBeenCalledWith({prefix: 'logs/'});
    });

    it('returns the next page token when a page size is given', async () => {
      fakes.bucket.getFiles.mockResolvedValue([
        [{name: 'test-object'}],
        {pageToken: 'next-page-token'},
      ]);
      const tool = await getTool(toolset, 'gcs_list_objects');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', page_size: 1, page_token: 'token'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: ['test-object'],
        next_page_token: 'next-page-token',
      });
      expect(fakes.bucket.getFiles).toHaveBeenCalledWith({
        maxResults: 1,
        pageToken: 'token',
        autoPaginate: false,
      });
    });

    it('omits the next page token on the last page', async () => {
      fakes.bucket.getFiles.mockResolvedValue([
        [{name: 'test-object'}],
        {pageToken: undefined},
      ]);
      const tool = await getTool(toolset, 'gcs_list_objects');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', page_size: 1},
        toolContext,
      });

      expect(result).toStrictEqual({
        status: GcsToolStatus.SUCCESS,
        results: ['test-object'],
      });
    });

    it('omits the next page token when the client returns no next query', async () => {
      fakes.bucket.getFiles.mockResolvedValue([[{name: 'test-object'}]]);
      const tool = await getTool(toolset, 'gcs_list_objects');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', page_size: 1},
        toolContext,
      });

      expect(result).toStrictEqual({
        status: GcsToolStatus.SUCCESS,
        results: ['test-object'],
      });
    });

    it('reports a failed request as an error result', async () => {
      fakes.bucket.getFiles.mockRejectedValue(new Error('list failed'));
      const tool = await getTool(toolset, 'gcs_list_objects');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'list failed',
      });
    });
  });

  describe('gcs_get_object_metadata', () => {
    it('returns the object metadata and selects the requested generation', async () => {
      const tool = await getTool(toolset, 'gcs_get_object_metadata');

      const result = await tool.runAsync({
        args: {
          bucket_name: 'test-bucket',
          object_name: 'test-object',
          generation: 1,
        },
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: OBJECT_METADATA,
      });
      expect(fakes.bucket.file).toHaveBeenCalledWith('test-object', {
        generation: 1,
      });
    });

    it('omits the generation when none is requested', async () => {
      const tool = await getTool(toolset, 'gcs_get_object_metadata');

      await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_name: 'test-object'},
        toolContext,
      });

      expect(fakes.bucket.file).toHaveBeenCalledWith('test-object', undefined);
    });

    it('reports a missing object as not found', async () => {
      fakes.file.getMetadata.mockRejectedValue(apiError(404, 'No such object'));
      const tool = await getTool(toolset, 'gcs_get_object_metadata');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_name: 'missing'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'Object missing not found in bucket test-bucket',
      });
    });

    it('keeps a non-404 failure as a plain error result', async () => {
      fakes.file.getMetadata.mockRejectedValue(apiError(500, 'server error'));
      const tool = await getTool(toolset, 'gcs_get_object_metadata');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_name: 'test-object'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'server error',
      });
    });
  });

  describe('gcs_get_object_data', () => {
    it('returns UTF-8 payloads as text', async () => {
      const tool = await getTool(toolset, 'gcs_get_object_data');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_name: 'test-object'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: 'content',
        encoding: 'text',
      });
    });

    it('selects the requested generation', async () => {
      const tool = await getTool(toolset, 'gcs_get_object_data');

      await tool.runAsync({
        args: {
          bucket_name: 'test-bucket',
          object_name: 'test-object',
          generation: 7,
        },
        toolContext,
      });

      expect(fakes.bucket.file).toHaveBeenCalledWith('test-object', {
        generation: 7,
      });
    });

    it('returns binary payloads as base64', async () => {
      fakes.file.download.mockResolvedValue([Buffer.from([0xff, 0xff])]);
      const tool = await getTool(toolset, 'gcs_get_object_data');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_name: 'test-object'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: '//8=',
        encoding: 'base64',
      });
    });

    it('downloads to a local path when one is given', async () => {
      const tool = await getTool(toolset, 'gcs_get_object_data');

      const result = await tool.runAsync({
        args: {
          bucket_name: 'test-bucket',
          object_name: 'test-object',
          destination_file_path: 'path/to/download.txt',
        },
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results:
          'Object test-object downloaded successfully to path/to/download.txt.',
      });
      expect(fakes.file.download).toHaveBeenCalledWith({
        destination: 'path/to/download.txt',
      });
    });

    it('reports a missing object as not found', async () => {
      fakes.file.download.mockRejectedValue(apiError(404, 'No such object'));
      const tool = await getTool(toolset, 'gcs_get_object_data');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_name: 'missing'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'Object missing not found in bucket test-bucket',
      });
    });

    it('stringifies a rejection that is not an Error', async () => {
      fakes.file.download.mockRejectedValue('download exploded');
      const tool = await getTool(toolset, 'gcs_get_object_data');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_name: 'test-object'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'download exploded',
      });
    });
  });

  describe('gcs_create_object', () => {
    it('uploads inline data', async () => {
      const tool = await getTool(toolset, 'gcs_create_object');

      const result = await tool.runAsync({
        args: {
          bucket_name: 'test-bucket',
          object_name: 'test-object',
          data: 'data',
        },
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results:
          'Object test-object created successfully in bucket test-bucket.',
      });
      expect(fakes.file.save).toHaveBeenCalledWith('data');
      expect(fakes.bucket.upload).not.toHaveBeenCalled();
    });

    it('uploads a local file', async () => {
      const tool = await getTool(toolset, 'gcs_create_object');

      const result = await tool.runAsync({
        args: {
          bucket_name: 'test-bucket',
          object_name: 'test-object',
          source_file_path: 'path/to/file.txt',
        },
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results:
          'Object test-object created successfully in bucket test-bucket.',
      });
      expect(fakes.bucket.upload).toHaveBeenCalledWith('path/to/file.txt', {
        destination: 'test-object',
      });
      expect(fakes.file.save).not.toHaveBeenCalled();
    });

    it('requires either data or a source file path', async () => {
      const tool = await getTool(toolset, 'gcs_create_object');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_name: 'test-object'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: "Either 'data' or 'source_file_path' must be provided.",
      });
      expect(fakes.file.save).not.toHaveBeenCalled();
      expect(fakes.bucket.upload).not.toHaveBeenCalled();
    });

    it('reports a failed upload as an error result', async () => {
      fakes.file.save.mockRejectedValue(new Error('upload failed'));
      const tool = await getTool(toolset, 'gcs_create_object');

      const result = await tool.runAsync({
        args: {
          bucket_name: 'test-bucket',
          object_name: 'test-object',
          data: 'data',
        },
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'upload failed',
      });
    });
  });

  describe('gcs_delete_objects', () => {
    it('deletes every requested object', async () => {
      const tool = await getTool(toolset, 'gcs_delete_objects');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_names: ['first', 'second']},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results:
          'Objects [first, second] deleted successfully from bucket test-bucket.',
      });
      expect(fakes.bucket.file).toHaveBeenCalledWith('first');
      expect(fakes.bucket.file).toHaveBeenCalledWith('second');
      expect(fakes.file.delete).toHaveBeenCalledTimes(2);
    });

    it('reports a failed delete as an error result', async () => {
      fakes.file.delete.mockRejectedValue(new Error('delete failed'));
      const tool = await getTool(toolset, 'gcs_delete_objects');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', object_names: ['first']},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'delete failed',
      });
    });
  });
});
