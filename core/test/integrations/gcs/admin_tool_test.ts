/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, GcsAdminToolset, GcsToolStatus} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createToolContext, getTool, READ_WRITE} from './test_utils.js';

const {StorageMock, fakes} = vi.hoisted(() => {
  const bucket = {setMetadata: vi.fn(), delete: vi.fn()};
  const storage = {
    bucket: vi.fn(() => bucket),
    getBuckets: vi.fn(),
    createBucket: vi.fn(),
  };
  return {StorageMock: vi.fn(() => storage), fakes: {bucket, storage}};
});

vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

describe('GCS admin tools', () => {
  let toolset: GcsAdminToolset;
  let toolContext: Context;

  beforeEach(async () => {
    vi.clearAllMocks();
    fakes.storage.getBuckets.mockResolvedValue([[{name: 'test-bucket'}]]);
    fakes.storage.createBucket.mockResolvedValue([{name: 'test-bucket'}]);
    fakes.bucket.setMetadata.mockResolvedValue(undefined);
    fakes.bucket.delete.mockResolvedValue(undefined);

    toolset = new GcsAdminToolset({toolSettings: READ_WRITE});
    toolContext = await createToolContext();
  });

  describe('gcs_list_buckets', () => {
    it('lists bucket names without pagination', async () => {
      const tool = await getTool(toolset, 'gcs_list_buckets');

      const result = await tool.runAsync({
        args: {project_id: 'test-project'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: ['test-bucket'],
      });
      expect(fakes.storage.getBuckets).toHaveBeenCalledWith({
        project: 'test-project',
      });
    });

    it('returns the next page token when a page size is given', async () => {
      fakes.storage.getBuckets.mockResolvedValue([
        [{name: 'test-bucket'}],
        {pageToken: 'next-page-token'},
      ]);
      const tool = await getTool(toolset, 'gcs_list_buckets');

      const result = await tool.runAsync({
        args: {project_id: 'test-project', page_size: 1, page_token: 'token'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: ['test-bucket'],
        next_page_token: 'next-page-token',
      });
      expect(fakes.storage.getBuckets).toHaveBeenCalledWith({
        project: 'test-project',
        maxResults: 1,
        pageToken: 'token',
        autoPaginate: false,
      });
    });

    it('reports a failed request as an error result', async () => {
      fakes.storage.getBuckets.mockRejectedValue(new Error('list failed'));
      const tool = await getTool(toolset, 'gcs_list_buckets');

      const result = await tool.runAsync({
        args: {project_id: 'test-project'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'list failed',
      });
    });
  });

  describe('gcs_create_bucket', () => {
    it('creates a bucket without a location', async () => {
      const tool = await getTool(toolset, 'gcs_create_bucket');

      const result = await tool.runAsync({
        args: {project_id: 'test-project', bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: 'Bucket test-bucket created successfully.',
      });
      expect(fakes.storage.createBucket).toHaveBeenCalledWith(
        'test-bucket',
        {},
      );
    });

    it('creates a bucket in the requested location', async () => {
      const tool = await getTool(toolset, 'gcs_create_bucket');

      await tool.runAsync({
        args: {
          project_id: 'test-project',
          bucket_name: 'test-bucket',
          location: 'US',
        },
        toolContext,
      });

      expect(fakes.storage.createBucket).toHaveBeenCalledWith('test-bucket', {
        location: 'US',
      });
    });

    it('reports a failed request as an error result', async () => {
      fakes.storage.createBucket.mockRejectedValue(new Error('create failed'));
      const tool = await getTool(toolset, 'gcs_create_bucket');

      const result = await tool.runAsync({
        args: {project_id: 'test-project', bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'create failed',
      });
    });
  });

  describe('gcs_update_bucket', () => {
    it('enables versioning', async () => {
      const tool = await getTool(toolset, 'gcs_update_bucket');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', versioning_enabled: true},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: 'Bucket test-bucket updated successfully.',
      });
      expect(fakes.bucket.setMetadata).toHaveBeenCalledWith({
        versioning: {enabled: true},
      });
    });

    it('enables uniform bucket-level access', async () => {
      const tool = await getTool(toolset, 'gcs_update_bucket');

      await tool.runAsync({
        args: {
          bucket_name: 'test-bucket',
          uniform_bucket_level_access_enabled: true,
        },
        toolContext,
      });

      expect(fakes.bucket.setMetadata).toHaveBeenCalledWith({
        iamConfiguration: {uniformBucketLevelAccess: {enabled: true}},
      });
    });

    it('applies both fields in a single patch', async () => {
      const tool = await getTool(toolset, 'gcs_update_bucket');

      await tool.runAsync({
        args: {
          bucket_name: 'test-bucket',
          versioning_enabled: false,
          uniform_bucket_level_access_enabled: false,
        },
        toolContext,
      });

      expect(fakes.bucket.setMetadata).toHaveBeenCalledTimes(1);
      expect(fakes.bucket.setMetadata).toHaveBeenCalledWith({
        versioning: {enabled: false},
        iamConfiguration: {uniformBucketLevelAccess: {enabled: false}},
      });
    });

    it('issues no patch when no updatable field is supplied', async () => {
      const tool = await getTool(toolset, 'gcs_update_bucket');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: 'Bucket test-bucket updated successfully.',
      });
      expect(fakes.bucket.setMetadata).not.toHaveBeenCalled();
    });

    it('reports a failed patch as an error result', async () => {
      fakes.bucket.setMetadata.mockRejectedValue(new Error('patch failed'));
      const tool = await getTool(toolset, 'gcs_update_bucket');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket', versioning_enabled: true},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'patch failed',
      });
    });
  });

  describe('gcs_delete_bucket', () => {
    it('deletes the bucket', async () => {
      const tool = await getTool(toolset, 'gcs_delete_bucket');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.SUCCESS,
        results: 'Bucket test-bucket deleted successfully.',
      });
      expect(fakes.storage.bucket).toHaveBeenCalledWith('test-bucket');
      expect(fakes.bucket.delete).toHaveBeenCalledTimes(1);
    });

    it('reports a failed delete as an error result', async () => {
      fakes.bucket.delete.mockRejectedValue(new Error('delete failed'));
      const tool = await getTool(toolset, 'gcs_delete_bucket');

      const result = await tool.runAsync({
        args: {bucket_name: 'test-bucket'},
        toolContext,
      });

      expect(result).toEqual({
        status: GcsToolStatus.ERROR,
        error_details: 'delete failed',
      });
    });
  });
});
