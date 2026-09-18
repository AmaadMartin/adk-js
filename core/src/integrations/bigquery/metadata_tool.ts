/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQuery} from '@google-cloud/bigquery';

/**
 * Lists the BigQuery dataset ids in a project.
 *
 * @param client The BigQuery client to read through.
 * @param projectId The Google Cloud project holding the datasets.
 * @return The dataset ids, in the order BigQuery listed them.
 */
export async function listDatasetIds(
  client: BigQuery,
  projectId: string,
): Promise<string[]> {
  const [datasets] = await client.getDatasets({projectId});
  return datasets.map((dataset) => dataset.id ?? '');
}

/**
 * Reads a dataset's metadata.
 *
 * @param client The BigQuery client to read through.
 * @param projectId The Google Cloud project holding the dataset.
 * @param datasetId The dataset to describe.
 * @return The dataset resource, as the BigQuery API returns it.
 */
export async function getDatasetInfo(
  client: BigQuery,
  projectId: string,
  datasetId: string,
): Promise<unknown> {
  const [metadata] = await client.dataset(datasetId, {projectId}).getMetadata();
  return metadata;
}

/**
 * Lists the table ids in a dataset.
 *
 * @param client The BigQuery client to read through.
 * @param projectId The Google Cloud project holding the dataset.
 * @param datasetId The dataset to list.
 * @return The table ids, in the order BigQuery listed them.
 */
export async function listTableIds(
  client: BigQuery,
  projectId: string,
  datasetId: string,
): Promise<string[]> {
  const [tables] = await client.dataset(datasetId, {projectId}).getTables();
  return tables.map((table) => table.id ?? '');
}

/**
 * Reads a table's metadata, including its schema.
 *
 * @param client The BigQuery client to read through.
 * @param projectId The Google Cloud project holding the dataset.
 * @param datasetId The dataset holding the table.
 * @param tableId The table to describe.
 * @return The table resource, as the BigQuery API returns it.
 */
export async function getTableInfo(
  client: BigQuery,
  projectId: string,
  datasetId: string,
  tableId: string,
): Promise<unknown> {
  const [metadata] = await client
    .dataset(datasetId, {projectId})
    .table(tableId)
    .getMetadata();
  return metadata;
}

/**
 * Reads a job's metadata: its configuration, statistics, status and query.
 *
 * @param client The BigQuery client to read through.
 * @param jobId The job to describe. BigQuery also accepts the qualified form
 *     `project_id:region.job_id`.
 * @return The job resource, as the BigQuery API returns it.
 */
export async function getJobInfo(
  client: BigQuery,
  jobId: string,
): Promise<unknown> {
  const [metadata] = await client.job(jobId).getMetadata();
  return metadata;
}
