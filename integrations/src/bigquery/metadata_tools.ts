/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DatasetResource,
  JobMetadata,
  TableMetadata,
} from '@google-cloud/bigquery';

import {BigQueryToolConfig} from './bigquery_config.js';
import {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {BigQueryToolError, toToolError} from './bigquery_results.js';
import {getBigQueryClient} from './client.js';

/** Successful result of {@link listDatasetIds}. */
export interface ListDatasetIdsResult {
  status: 'SUCCESS';
  datasets: string[];
}

/** Successful result of {@link listTableIds}. */
export interface ListTableIdsResult {
  status: 'SUCCESS';
  tables: string[];
}

export async function listDatasetIds(
  projectId: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
): Promise<ListDatasetIdsResult | BigQueryToolError> {
  try {
    const bqClient = getBigQueryClient(
      projectId,
      credentialsConfig,
      settings,
      'list_dataset_ids',
    );
    const [datasets] = await bqClient.getDatasets();
    return {
      status: 'SUCCESS',
      datasets: datasets
        .map((d) => d.id)
        .filter((id): id is string => id != null),
    };
  } catch (error) {
    return toToolError(error);
  }
}

export async function getDatasetInfo(
  projectId: string,
  datasetId: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
): Promise<DatasetResource | BigQueryToolError> {
  try {
    const bqClient = getBigQueryClient(
      projectId,
      credentialsConfig,
      settings,
      'get_dataset_info',
    );
    const [dataset] = await bqClient.dataset(datasetId).get();
    return dataset.metadata;
  } catch (error) {
    return toToolError(error);
  }
}

export async function listTableIds(
  projectId: string,
  datasetId: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
): Promise<ListTableIdsResult | BigQueryToolError> {
  try {
    const bqClient = getBigQueryClient(
      projectId,
      credentialsConfig,
      settings,
      'list_table_ids',
    );
    const [tables] = await bqClient.dataset(datasetId).getTables();
    return {
      status: 'SUCCESS',
      tables: tables.map((t) => t.id).filter((id): id is string => id != null),
    };
  } catch (error) {
    return toToolError(error);
  }
}

export async function getTableInfo(
  projectId: string,
  datasetId: string,
  tableId: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
): Promise<TableMetadata | BigQueryToolError> {
  try {
    const bqClient = getBigQueryClient(
      projectId,
      credentialsConfig,
      settings,
      'get_table_info',
    );
    const [table] = await bqClient.dataset(datasetId).table(tableId).get();
    return table.metadata;
  } catch (error) {
    return toToolError(error);
  }
}

export async function getJobInfo(
  projectId: string,
  jobId: string,
  location?: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
): Promise<JobMetadata | BigQueryToolError> {
  try {
    const bqClient = getBigQueryClient(
      projectId,
      credentialsConfig,
      settings,
      'get_job_info',
    );
    const [job] = await bqClient.job(jobId, {location}).get();
    return job.metadata;
  } catch (error) {
    return toToolError(error);
  }
}
