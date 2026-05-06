/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import * as metadataTools from '../../../src/tools/bigquery/metadata_tools.js';

const mockGetDatasets = vi.fn();
const mockGetDataset = vi.fn();
const mockGetTables = vi.fn();
const mockGetTable = vi.fn();
const mockGetJob = vi.fn();

vi.mock('@google-cloud/bigquery', () => {
  return {
    BigQuery: vi.fn().mockImplementation(() => {
      return {
        getDatasets: mockGetDatasets,
        dataset: vi.fn().mockImplementation(() => {
          return {
            get: mockGetDataset,
            getTables: mockGetTables,
            table: vi.fn().mockImplementation(() => {
              return {
                get: mockGetTable,
              };
            }),
          };
        }),
        job: vi.fn().mockImplementation(() => {
          return {
            get: mockGetJob,
          };
        }),
      };
    }),
  };
});

describe('Metadata Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listDatasetIds', () => {
    it('should return dataset ids on success', async () => {
      mockGetDatasets.mockResolvedValue([
        [{id: 'project:dataset1'}, {id: 'project:dataset2'}],
      ]);

      const result = await metadataTools.listDatasetIds({
        projectId: 'test-project',
      });
      expect(result).toEqual(['dataset1', 'dataset2']);
      expect(mockGetDatasets).toHaveBeenCalled();
    });

    it('should return error on failure', async () => {
      mockGetDatasets.mockRejectedValue('Failed to get datasets');

      const result = await metadataTools.listDatasetIds({
        projectId: 'test-project',
      });
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Failed to get datasets',
      });
    });
  });

  describe('getDatasetInfo', () => {
    it('should return dataset metadata on success', async () => {
      const mockMetadata = {kind: 'bigquery#dataset', id: 'project:dataset1'};
      mockGetDataset.mockResolvedValue([{}, mockMetadata]);

      const result = await metadataTools.getDatasetInfo({
        projectId: 'test-project',
        datasetId: 'dataset1',
      });
      expect(result).toEqual(mockMetadata);
      expect(mockGetDataset).toHaveBeenCalled();
    });

    it('should return error on failure', async () => {
      mockGetDataset.mockRejectedValue('Failed to get dataset');

      const result = await metadataTools.getDatasetInfo({
        projectId: 'test-project',
        datasetId: 'dataset1',
      });
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Failed to get dataset',
      });
    });
  });

  describe('listTableIds', () => {
    it('should return table ids on success', async () => {
      mockGetTables.mockResolvedValue([
        [{id: 'project.dataset.table1'}, {id: 'project.dataset.table2'}],
      ]);

      const result = await metadataTools.listTableIds({
        projectId: 'test-project',
        datasetId: 'dataset1',
      });
      expect(result).toEqual(['table1', 'table2']);
      expect(mockGetTables).toHaveBeenCalled();
    });

    it('should return error on failure', async () => {
      mockGetTables.mockRejectedValue('Failed to get tables');

      const result = await metadataTools.listTableIds({
        projectId: 'test-project',
        datasetId: 'dataset1',
      });
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Failed to get tables',
      });
    });
  });

  describe('getTableInfo', () => {
    it('should return table metadata on success', async () => {
      const mockMetadata = {
        kind: 'bigquery#table',
        id: 'project:dataset1.table1',
      };
      mockGetTable.mockResolvedValue([{}, mockMetadata]);

      const result = await metadataTools.getTableInfo({
        projectId: 'test-project',
        datasetId: 'dataset1',
        tableId: 'table1',
      });
      expect(result).toEqual(mockMetadata);
      expect(mockGetTable).toHaveBeenCalled();
    });

    it('should return error on failure', async () => {
      mockGetTable.mockRejectedValue('Failed to get table');

      const result = await metadataTools.getTableInfo({
        projectId: 'test-project',
        datasetId: 'dataset1',
        tableId: 'table1',
      });
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Failed to get table',
      });
    });
  });

  describe('getJobInfo', () => {
    it('should return job metadata on success', async () => {
      const mockMetadata = {kind: 'bigquery#job', id: 'project:job1'};
      mockGetJob.mockResolvedValue([{}, mockMetadata]);

      const result = await metadataTools.getJobInfo({
        projectId: 'test-project',
        jobId: 'job1',
      });
      expect(result).toEqual(mockMetadata);
      expect(mockGetJob).toHaveBeenCalled();
    });

    it('should return error on failure', async () => {
      mockGetJob.mockRejectedValue('Failed to get job');

      const result = await metadataTools.getJobInfo({
        projectId: 'test-project',
        jobId: 'job1',
      });
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Failed to get job',
      });
    });
  });
});
