/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DatasetResource, TableMetadata} from '@google-cloud/bigquery';
import {z} from 'zod';

import {BigQueryCredentials} from './bigquery_credentials.js';
import {BigQueryToolError, toBigQueryToolError} from './bigquery_tool.js';
import {getBigQueryClient} from './client.js';

// Argument names are model-facing and stay `snake_case`, matching the function
// declarations adk-python generates from its Python signatures.

/** Arguments of {@link listDatasetIds}. */
export const LIST_DATASET_IDS_PARAMETERS = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
});

/** Arguments of {@link getDatasetInfo} and {@link listTableIds}. */
export const DATASET_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z.string().describe('The BigQuery dataset id.'),
});

/** Arguments of {@link getTableInfo}. */
export const GET_TABLE_INFO_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z
    .string()
    .describe('The BigQuery dataset id containing the table.'),
  table_id: z.string().describe('The BigQuery table id.'),
});

/** Model-facing description of {@link listDatasetIds}. */
export const LIST_DATASET_IDS_DESCRIPTION =
  'List BigQuery dataset ids in a Google Cloud project.';

/** Model-facing description of {@link getDatasetInfo}. */
export const GET_DATASET_INFO_DESCRIPTION =
  'Get metadata information about a BigQuery dataset.';

/** Model-facing description of {@link listTableIds}. */
export const LIST_TABLE_IDS_DESCRIPTION =
  'List table ids in a BigQuery dataset.';

/** Model-facing description of {@link getTableInfo}. */
export const GET_TABLE_INFO_DESCRIPTION =
  'Get metadata information about a BigQuery table.';

/**
 * Lists the BigQuery dataset ids in a project.
 *
 * @param input The project to list.
 * @param credentials The credential to call BigQuery with.
 * @return The dataset ids, or the error payload.
 */
export async function listDatasetIds(
  input: z.infer<typeof LIST_DATASET_IDS_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<string[] | BigQueryToolError> {
  try {
    const projectId = input.project_id;
    const client = await getBigQueryClient({projectId, credentials});
    const [datasets] = await client.getDatasets({projectId});
    return datasets.flatMap((dataset) => (dataset.id ? [dataset.id] : []));
  } catch (err: unknown) {
    return toBigQueryToolError(err);
  }
}

/**
 * Reads the metadata of a BigQuery dataset.
 *
 * @param input The dataset to describe.
 * @param credentials The credential to call BigQuery with.
 * @return The `bigquery#dataset` REST resource, or the error payload.
 */
export async function getDatasetInfo(
  input: z.infer<typeof DATASET_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<DatasetResource | BigQueryToolError> {
  try {
    const projectId = input.project_id;
    const client = await getBigQueryClient({projectId, credentials});
    const dataset = client.dataset(input.dataset_id, {projectId});
    // `getMetadata()` is declared `[any, Response]` by the client library, so
    // the destructuring target carries the type instead.
    const [metadata]: [DatasetResource, unknown] = await dataset.getMetadata();
    return metadata;
  } catch (err: unknown) {
    return toBigQueryToolError(err);
  }
}

/**
 * Lists the table ids in a BigQuery dataset.
 *
 * @param input The dataset to list.
 * @param credentials The credential to call BigQuery with.
 * @return The table ids, or the error payload.
 */
export async function listTableIds(
  input: z.infer<typeof DATASET_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<string[] | BigQueryToolError> {
  try {
    const projectId = input.project_id;
    const client = await getBigQueryClient({projectId, credentials});
    const [tables] = await client
      .dataset(input.dataset_id, {projectId})
      .getTables();
    return tables.flatMap((table) => (table.id ? [table.id] : []));
  } catch (err: unknown) {
    return toBigQueryToolError(err);
  }
}

/**
 * Reads the metadata of a BigQuery table.
 *
 * @param input The table to describe.
 * @param credentials The credential to call BigQuery with.
 * @return The `bigquery#table` REST resource, or the error payload.
 */
export async function getTableInfo(
  input: z.infer<typeof GET_TABLE_INFO_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<TableMetadata | BigQueryToolError> {
  try {
    const projectId = input.project_id;
    const client = await getBigQueryClient({projectId, credentials});
    const table = client
      .dataset(input.dataset_id, {projectId})
      .table(input.table_id);
    const [metadata]: [TableMetadata, unknown] = await table.getMetadata();
    return metadata;
  } catch (err: unknown) {
    return toBigQueryToolError(err);
  }
}
