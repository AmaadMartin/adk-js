/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  getDatasetInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
} from '../../../src/tools/bigquery/metadata_tool.js';

const {BigQueryMock, fake} = vi.hoisted(() => {
  const fake = {
    datasets: [] as Array<{id?: string}>,
    tables: [] as Array<{id?: string}>,
    datasetMetadata: {} as Record<string, unknown>,
    tableMetadata: {} as Record<string, unknown>,
    failure: undefined as Error | undefined,
    /** Records how the code under test addressed the service. */
    calls: [] as Array<Record<string, unknown>>,
  };

  class FakeTable {
    constructor(private readonly tableId: string) {}

    async getMetadata(): Promise<[Record<string, unknown>, unknown]> {
      fake.calls.push({tableId: this.tableId});
      if (fake.failure) throw fake.failure;
      return [fake.tableMetadata, undefined];
    }
  }

  class FakeDataset {
    constructor(
      private readonly datasetId: string,
      private readonly options: {projectId?: string},
    ) {}

    table(tableId: string): FakeTable {
      return new FakeTable(tableId);
    }

    async getMetadata(): Promise<[Record<string, unknown>, unknown]> {
      fake.calls.push({datasetId: this.datasetId, ...this.options});
      if (fake.failure) throw fake.failure;
      return [fake.datasetMetadata, undefined];
    }

    async getTables(): Promise<[Array<{id?: string}>]> {
      fake.calls.push({datasetId: this.datasetId, ...this.options});
      if (fake.failure) throw fake.failure;
      return [fake.tables];
    }
  }

  class FakeBigQuery {
    dataset(id: string, options: {projectId?: string} = {}): FakeDataset {
      return new FakeDataset(id, options);
    }

    async getDatasets(options: {
      projectId?: string;
    }): Promise<[Array<{id?: string}>]> {
      fake.calls.push(options);
      if (fake.failure) throw fake.failure;
      return [fake.datasets];
    }
  }

  return {BigQueryMock: FakeBigQuery, fake};
});

vi.mock('@google-cloud/bigquery', () => ({BigQuery: BigQueryMock}));

describe('BigQuery metadata tools', () => {
  beforeEach(() => {
    fake.datasets = [];
    fake.tables = [];
    fake.datasetMetadata = {};
    fake.tableMetadata = {};
    fake.failure = undefined;
    fake.calls = [];
  });

  it('lists the dataset ids of a project', async () => {
    fake.datasets = [{id: 'ml_datasets'}, {id: 'austin_311'}];

    const result = await listDatasetIds({project_id: 'bigquery-public-data'});

    expect(result).toEqual(['ml_datasets', 'austin_311']);
    expect(fake.calls).toEqual([{projectId: 'bigquery-public-data'}]);
  });

  it('drops a dataset the service returned without an id', async () => {
    fake.datasets = [{id: 'ml_datasets'}, {}];

    await expect(listDatasetIds({project_id: 'p'})).resolves.toEqual([
      'ml_datasets',
    ]);
  });

  it('returns the dataset REST resource', async () => {
    fake.datasetMetadata = {kind: 'bigquery#dataset', location: 'US'};

    const result = await getDatasetInfo({
      project_id: 'bigquery-public-data',
      dataset_id: 'ml_datasets',
    });

    expect(result).toEqual({kind: 'bigquery#dataset', location: 'US'});
    expect(fake.calls).toEqual([
      {datasetId: 'ml_datasets', projectId: 'bigquery-public-data'},
    ]);
  });

  it('lists the table ids of a dataset', async () => {
    fake.tables = [{id: 'penguins'}, {}, {id: 'iris'}];

    const result = await listTableIds({
      project_id: 'bigquery-public-data',
      dataset_id: 'ml_datasets',
    });

    expect(result).toEqual(['penguins', 'iris']);
    expect(fake.calls).toEqual([
      {datasetId: 'ml_datasets', projectId: 'bigquery-public-data'},
    ]);
  });

  it('returns the table REST resource', async () => {
    fake.tableMetadata = {kind: 'bigquery#table', numRows: '344'};

    const result = await getTableInfo({
      project_id: 'bigquery-public-data',
      dataset_id: 'ml_datasets',
      table_id: 'penguins',
    });

    expect(result).toEqual({kind: 'bigquery#table', numRows: '344'});
    expect(fake.calls).toEqual([{tableId: 'penguins'}]);
  });

  it.each([
    {
      name: 'list_dataset_ids',
      run: () => listDatasetIds({project_id: 'p'}),
    },
    {
      name: 'get_dataset_info',
      run: () => getDatasetInfo({project_id: 'p', dataset_id: 'd'}),
    },
    {
      name: 'list_table_ids',
      run: () => listTableIds({project_id: 'p', dataset_id: 'd'}),
    },
    {
      name: 'get_table_info',
      run: () =>
        getTableInfo({project_id: 'p', dataset_id: 'd', table_id: 't'}),
    },
  ])('reports a failing $name as an error payload', async ({run}) => {
    fake.failure = new Error('Access Denied: Project p');

    await expect(run()).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Access Denied: Project p',
    });
  });
});
