/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQuery} from '@google-cloud/bigquery';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {getBigQueryClient} from '../../../src/tools/bigquery/client_helper.js';
import {
  getDatasetInfo,
  getJobInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
} from '../../../src/tools/bigquery/metadata_tools.js';

vi.mock('../../../src/tools/bigquery/client_helper.js', () => ({
  getBigQueryClient: vi.fn(),
}));

describe('metadata_tools', () => {
  const mockTable = {
    get: vi.fn(),
  };
  const mockDataset = {
    get: vi.fn(),
    getTables: vi.fn(),
    table: vi.fn().mockReturnValue(mockTable),
  };
  const mockJob = {
    get: vi.fn(),
  };
  const mockClient = {
    getDatasets: vi.fn(),
    dataset: vi.fn().mockReturnValue(mockDataset),
    job: vi.fn().mockReturnValue(mockJob),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBigQueryClient).mockResolvedValue(
      mockClient as unknown as BigQuery,
    );
  });

  describe('listDatasetIds', () => {
    it('should list dataset ids successfully', async () => {
      mockClient.getDatasets.mockResolvedValue([
        [{id: 'project:dataset1'}, {id: 'dataset2'}],
      ]);

      const result = await listDatasetIds({projectId: 'p'});
      expect(result).toEqual(['dataset1', 'dataset2']);
      expect(getBigQueryClient).toHaveBeenCalledWith(
        'p',
        undefined,
        undefined,
        undefined,
      );
    });

    it('should handle errors', async () => {
      mockClient.getDatasets.mockRejectedValue(new Error('API Error'));

      const result = await listDatasetIds({projectId: 'p'});
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'API Error',
      });
    });

    it('should handle non-Error errors', async () => {
      mockClient.getDatasets.mockRejectedValue('String Error');

      const result = await listDatasetIds({projectId: 'p'});
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'String Error',
      });
    });
  });

  describe('getDatasetInfo', () => {
    it('should get dataset info successfully', async () => {
      const mockApiResponse = {kind: 'bigquery#dataset', id: 'p:d'};
      mockDataset.get.mockResolvedValue([null, mockApiResponse]);

      const result = await getDatasetInfo({projectId: 'p', datasetId: 'd'});
      expect(result).toEqual(mockApiResponse);
      expect(mockClient.dataset).toHaveBeenCalledWith('d');
    });

    it('should handle errors', async () => {
      mockDataset.get.mockRejectedValue(new Error('API Error'));

      const result = await getDatasetInfo({projectId: 'p', datasetId: 'd'});
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'API Error',
      });
    });

    it('should handle non-Error errors', async () => {
      mockDataset.get.mockRejectedValue('String Error');

      const result = await getDatasetInfo({projectId: 'p', datasetId: 'd'});
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'String Error',
      });
    });
  });

  describe('listTableIds', () => {
    it('should list table ids successfully', async () => {
      mockDataset.getTables.mockResolvedValue([
        [{id: 'project.dataset.table1'}, {id: 'table2'}],
      ]);

      const result = await listTableIds({projectId: 'p', datasetId: 'd'});
      expect(result).toEqual(['table1', 'table2']);
      expect(mockClient.dataset).toHaveBeenCalledWith('d');
    });

    it('should handle errors', async () => {
      mockDataset.getTables.mockRejectedValue(new Error('API Error'));

      const result = await listTableIds({projectId: 'p', datasetId: 'd'});
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'API Error',
      });
    });

    it('should handle non-Error errors', async () => {
      mockDataset.getTables.mockRejectedValue('String Error');

      const result = await listTableIds({projectId: 'p', datasetId: 'd'});
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'String Error',
      });
    });
  });

  describe('getTableInfo', () => {
    it('should get table info successfully', async () => {
      const mockApiResponse = {kind: 'bigquery#table', id: 'p:d.t'};
      mockTable.get.mockResolvedValue([null, mockApiResponse]);

      const result = await getTableInfo({
        projectId: 'p',
        datasetId: 'd',
        tableId: 't',
      });
      expect(result).toEqual(mockApiResponse);
      expect(mockDataset.table).toHaveBeenCalledWith('t');
    });

    it('should handle errors', async () => {
      mockTable.get.mockRejectedValue(new Error('API Error'));

      const result = await getTableInfo({
        projectId: 'p',
        datasetId: 'd',
        tableId: 't',
      });
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'API Error',
      });
    });

    it('should handle non-Error errors', async () => {
      mockTable.get.mockRejectedValue('String Error');

      const result = await getTableInfo({
        projectId: 'p',
        datasetId: 'd',
        tableId: 't',
      });
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'String Error',
      });
    });
  });

  describe('getJobInfo', () => {
    it('should get job info successfully', async () => {
      const mockApiResponse = {kind: 'bigquery#job', id: 'p:j'};
      mockJob.get.mockResolvedValue([null, mockApiResponse]);

      const result = await getJobInfo({projectId: 'p', jobId: 'j'});
      expect(result).toEqual(mockApiResponse);
      expect(mockClient.job).toHaveBeenCalledWith('j');
    });

    it('should handle errors', async () => {
      mockJob.get.mockRejectedValue(new Error('API Error'));

      const result = await getJobInfo({projectId: 'p', jobId: 'j'});
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'API Error',
      });
    });

    it('should handle non-Error errors', async () => {
      mockJob.get.mockRejectedValue('String Error');

      const result = await getJobInfo({projectId: 'p', jobId: 'j'});
      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'String Error',
      });
    });
  });
});
