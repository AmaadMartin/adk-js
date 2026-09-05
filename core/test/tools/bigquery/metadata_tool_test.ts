/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_metadata_tool.py`
 * (branch `main`).
 */

import {
  BigQueryClientCache,
  BQ_USER_AGENT,
  createBigQueryToolConfig,
  getDatasetInfo,
  getJobInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
  type BigQueryToolDeps,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {bigQueryState, resetBigQueryState} from './bigquery_fakes.js';

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery} = await import('./bigquery_fakes.js');
  return {BigQuery: FakeBigQuery};
});

/** Builds the deps a metadata tool runs with. */
function deps(applicationName?: string): BigQueryToolDeps {
  return {
    clients: new BigQueryClientCache(),
    settings: createBigQueryToolConfig({applicationName}),
  };
}

beforeEach(() => {
  resetBigQueryState();
});

describe('listDatasetIds', () => {
  it('test_list_dataset_ids_no_default_auth', async () => {
    bigQueryState.datasetIds = ['dataset1', 'dataset2'];

    await expect(
      listDatasetIds({project_id: 'test-project'}, deps()),
    ).resolves.toEqual(['dataset1', 'dataset2']);
  });

  it('test_list_dataset_ids_bq_client_creation', async () => {
    await listDatasetIds({project_id: 'test-project'}, deps('my-agent'));

    expect(bigQueryState.clientOptions[0]).toMatchObject({
      projectId: 'test-project',
      userAgent: `${BQ_USER_AGENT} my-agent list_dataset_ids`,
    });
  });

  it('returns the failure envelope when BigQuery refuses', async () => {
    bigQueryState.metadataError = new Error('Permission denied');

    await expect(
      listDatasetIds({project_id: 'test-project'}, deps()),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Permission denied',
    });
  });
});

describe('getDatasetInfo', () => {
  it('test_get_dataset_info_no_default_auth', async () => {
    bigQueryState.datasetMetadata = {id: 'test-project:dataset1'};

    await expect(
      getDatasetInfo(
        {project_id: 'test-project', dataset_id: 'dataset1'},
        deps(),
      ),
    ).resolves.toEqual({id: 'test-project:dataset1'});
    expect(bigQueryState.requestedDatasets).toEqual(['dataset1']);
  });

  it('test_get_dataset_info_bq_client_creation', async () => {
    await getDatasetInfo(
      {project_id: 'test-project', dataset_id: 'dataset1'},
      deps(),
    );

    expect(bigQueryState.clientOptions[0].userAgent).toBe(
      `${BQ_USER_AGENT} get_dataset_info`,
    );
  });

  it('returns the failure envelope when BigQuery refuses', async () => {
    bigQueryState.metadataError = new Error('Not found: Dataset dataset1');

    await expect(
      getDatasetInfo(
        {project_id: 'test-project', dataset_id: 'dataset1'},
        deps(),
      ),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Not found: Dataset dataset1',
    });
  });
});

describe('listTableIds', () => {
  it('test_list_table_ids_no_default_auth', async () => {
    bigQueryState.tableIds = ['table1', 'table2'];

    await expect(
      listTableIds(
        {project_id: 'test-project', dataset_id: 'dataset1'},
        deps(),
      ),
    ).resolves.toEqual(['table1', 'table2']);
  });

  it('test_list_table_ids_bq_client_creation', async () => {
    await listTableIds(
      {project_id: 'test-project', dataset_id: 'dataset1'},
      deps(),
    );

    expect(bigQueryState.clientOptions[0].userAgent).toBe(
      `${BQ_USER_AGENT} list_table_ids`,
    );
  });

  it('returns the failure envelope when BigQuery refuses', async () => {
    bigQueryState.metadataError = new Error('Not found: Dataset dataset1');

    await expect(
      listTableIds(
        {project_id: 'test-project', dataset_id: 'dataset1'},
        deps(),
      ),
    ).resolves.toMatchObject({status: 'ERROR'});
  });
});

describe('getTableInfo', () => {
  it('test_get_table_info_no_default_auth', async () => {
    bigQueryState.tableMetadata = {id: 'test-project:dataset1.table1'};

    await expect(
      getTableInfo(
        {
          project_id: 'test-project',
          dataset_id: 'dataset1',
          table_id: 'table1',
        },
        deps(),
      ),
    ).resolves.toEqual({id: 'test-project:dataset1.table1'});
    expect(bigQueryState.requestedTables).toEqual(['table1']);
  });

  it('test_get_table_info_bq_client_creation', async () => {
    await getTableInfo(
      {project_id: 'test-project', dataset_id: 'dataset1', table_id: 'table1'},
      deps(),
    );

    expect(bigQueryState.clientOptions[0].userAgent).toBe(
      `${BQ_USER_AGENT} get_table_info`,
    );
  });

  it('returns the failure envelope when BigQuery refuses', async () => {
    bigQueryState.metadataError = new Error('Not found: Table table1');

    await expect(
      getTableInfo(
        {
          project_id: 'test-project',
          dataset_id: 'dataset1',
          table_id: 'table1',
        },
        deps(),
      ),
    ).resolves.toMatchObject({status: 'ERROR'});
  });
});

describe('getJobInfo', () => {
  it('test_get_job_info_no_default_auth', async () => {
    bigQueryState.jobMetadata = {id: 'test-project:US.job1'};

    await expect(
      getJobInfo({project_id: 'test-project', job_id: 'job1'}, deps()),
    ).resolves.toEqual({id: 'test-project:US.job1'});
    expect(bigQueryState.requestedJobs).toEqual(['job1']);
  });

  it('test_get_job_info_bq_client_creation', async () => {
    await getJobInfo({project_id: 'test-project', job_id: 'job1'}, deps());

    expect(bigQueryState.clientOptions[0].userAgent).toBe(
      `${BQ_USER_AGENT} get_job_info`,
    );
  });

  it('returns the failure envelope when BigQuery refuses', async () => {
    bigQueryState.metadataError = new Error('Not found: Job job1');

    await expect(
      getJobInfo({project_id: 'test-project', job_id: 'job1'}, deps()),
    ).resolves.toMatchObject({status: 'ERROR'});
  });
});

describe('dataset and table listing', () => {
  it('drops an entry the client returned without an id', async () => {
    bigQueryState.datasetIds = ['dataset1', ''];
    bigQueryState.tableIds = ['table1', ''];

    await expect(
      listDatasetIds({project_id: 'test-project'}, deps()),
    ).resolves.toEqual(['dataset1']);
    await expect(
      listTableIds({project_id: 'test-project', dataset_id: 'd'}, deps()),
    ).resolves.toEqual(['table1']);
  });
});
