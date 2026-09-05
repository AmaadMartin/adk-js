/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_metadata_tool.py`.
 *
 * That file holds one case, `test_list_dataset_ids_credentials_used`, which
 * asserts the credential reaches `bigquery.Client`. It is ported below as
 * "hands the credential to the client". The error path each Python tool
 * carries is exercised through the toolset instead of through the module
 * functions, because `GoogleTool` is what turns a thrown error into the
 * result, not the functions themselves.
 */

import {getBigQueryClient} from '@google/adk/integrations/bigquery/client.js';
import {
  getDatasetInfo,
  getJobInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
} from '@google/adk/integrations/bigquery/metadata_tool.js';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {fakeState, resetFakes} from './bigquery_fakes.js';

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery} = await import('./bigquery_fakes.js');
  return {BigQuery: FakeBigQuery};
});

describe('metadata tools', () => {
  beforeEach(() => {
    resetFakes({
      datasetIds: ['sales', 'marketing'],
      datasetMetadata: {id: 'p:sales', location: 'US'},
      tableIds: ['orders', 'customers'],
      tableMetadata: {id: 'p:sales.orders', numRows: '10'},
      jobMetadata: {id: 'p:US.job-1', status: {state: 'DONE'}},
    });
  });

  it('lists the dataset ids of a project', async () => {
    const client = await getBigQueryClient({project: 'p'});

    expect(await listDatasetIds(client, 'p')).toEqual(['sales', 'marketing']);
    expect(fakeState.bigquery.calls.datasets[0].projectId).toBe('p');
  });

  it('reads a dataset resource', async () => {
    const client = await getBigQueryClient({project: 'p'});

    expect(await getDatasetInfo(client, 'p', 'sales')).toEqual({
      id: 'p:sales',
      location: 'US',
    });
    expect(fakeState.bigquery.calls.datasets[0]).toEqual({
      datasetId: 'sales',
      projectId: 'p',
    });
  });

  it('lists the table ids of a dataset', async () => {
    const client = await getBigQueryClient({project: 'p'});

    expect(await listTableIds(client, 'p', 'sales')).toEqual([
      'orders',
      'customers',
    ]);
  });

  it('reads a table resource', async () => {
    const client = await getBigQueryClient({project: 'p'});

    expect(await getTableInfo(client, 'p', 'sales', 'orders')).toEqual({
      id: 'p:sales.orders',
      numRows: '10',
    });
    expect(fakeState.bigquery.calls.tables).toEqual(['orders']);
  });

  it('reads a job resource', async () => {
    const client = await getBigQueryClient({project: 'p'});

    expect(await getJobInfo(client, 'job-1')).toEqual({
      id: 'p:US.job-1',
      status: {state: 'DONE'},
    });
    expect(fakeState.bigquery.calls.jobs).toEqual(['job-1']);
  });

  it('test_list_dataset_ids_credentials_used', async () => {
    const credentials = new OAuth2Client();
    await getBigQueryClient({project: 'p', credentials});

    expect(fakeState.bigquery.calls.constructed[0]['authClient']).toBe(
      credentials,
    );
  });

  it('reports an empty id for a resource the API did not name', async () => {
    resetFakes({datasetIds: [undefined], tableIds: [undefined]});
    const client = await getBigQueryClient({project: 'p'});

    expect(await listDatasetIds(client, 'p')).toEqual(['']);
    expect(await listTableIds(client, 'p', 'sales')).toEqual(['']);
  });

  it('lets a BigQuery failure out, for GoogleTool to shape', async () => {
    resetFakes({errors: {getDatasets: new Error('Access Denied')}});
    const client = await getBigQueryClient({project: 'p'});

    await expect(listDatasetIds(client, 'p')).rejects.toThrow('Access Denied');
  });
});
