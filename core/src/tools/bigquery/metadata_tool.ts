/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DatasetResource, TableMetadata} from '@google-cloud/bigquery';
import {z} from 'zod';

import {BaseTool} from '../base_tool.js';

import {
  BigQueryCredentials,
  BigQueryCredentialsConfig,
} from './bigquery_credentials.js';
import {BigQueryTool} from './bigquery_tool.js';
import {getBigQueryClient} from './client.js';

// Argument names are model-facing and stay `snake_case`, matching the function
// declarations adk-python generates from its Python signatures.

/** Arguments of {@link listDatasetIds}. */
const LIST_DATASET_IDS_PARAMETERS = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
});

/** Arguments of {@link getDatasetInfo} and {@link listTableIds}. */
const DATASET_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z.string().describe('The BigQuery dataset id.'),
});

/** Arguments of {@link getTableInfo}. */
const GET_TABLE_INFO_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z
    .string()
    .describe('The BigQuery dataset id containing the table.'),
  table_id: z.string().describe('The BigQuery table id.'),
});

/**
 * Lists the BigQuery dataset ids in a project.
 *
 * @param input The project to list.
 * @param credentials The credential to call BigQuery with.
 * @return The dataset ids.
 */
export async function listDatasetIds(
  input: z.infer<typeof LIST_DATASET_IDS_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<string[]> {
  const projectId = input.project_id;
  const client = await getBigQueryClient({projectId, credentials});
  const [datasets] = await client.getDatasets({projectId});
  return datasets.flatMap((dataset) => (dataset.id ? [dataset.id] : []));
}

/**
 * Reads the metadata of a BigQuery dataset.
 *
 * @param input The dataset to describe.
 * @param credentials The credential to call BigQuery with.
 * @return The `bigquery#dataset` REST resource.
 */
export async function getDatasetInfo(
  input: z.infer<typeof DATASET_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<DatasetResource> {
  const projectId = input.project_id;
  const client = await getBigQueryClient({projectId, credentials});
  const dataset = client.dataset(input.dataset_id, {projectId});
  // `getMetadata()` is declared `[any, Response]` by the client library, so
  // the destructuring target carries the type instead.
  const [metadata]: [DatasetResource, unknown] = await dataset.getMetadata();
  return metadata;
}

/**
 * Lists the table ids in a BigQuery dataset.
 *
 * @param input The dataset to list.
 * @param credentials The credential to call BigQuery with.
 * @return The table ids.
 */
export async function listTableIds(
  input: z.infer<typeof DATASET_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<string[]> {
  const projectId = input.project_id;
  const client = await getBigQueryClient({projectId, credentials});
  const [tables] = await client
    .dataset(input.dataset_id, {projectId})
    .getTables();
  return tables.flatMap((table) => (table.id ? [table.id] : []));
}

/**
 * Reads the metadata of a BigQuery table.
 *
 * @param input The table to describe.
 * @param credentials The credential to call BigQuery with.
 * @return The `bigquery#table` REST resource.
 */
export async function getTableInfo(
  input: z.infer<typeof GET_TABLE_INFO_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<TableMetadata> {
  const projectId = input.project_id;
  const client = await getBigQueryClient({projectId, credentials});
  const table = client
    .dataset(input.dataset_id, {projectId})
    .table(input.table_id);
  const [metadata]: [TableMetadata, unknown] = await table.getMetadata();
  return metadata;
}

/**
 * Builds the four BigQuery metadata tools.
 *
 * @param credentialsConfig How each tool obtains its OAuth credential.
 * @return The tools, in adk-python's declaration order.
 */
export function createMetadataTools(
  credentialsConfig?: BigQueryCredentialsConfig,
): BaseTool[] {
  return [
    new BigQueryTool({
      name: 'list_dataset_ids',
      description: 'List BigQuery dataset ids in a Google Cloud project.',
      parameters: LIST_DATASET_IDS_PARAMETERS,
      execute: listDatasetIds,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'get_dataset_info',
      description: 'Get metadata information about a BigQuery dataset.',
      parameters: DATASET_PARAMETERS,
      execute: getDatasetInfo,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'list_table_ids',
      description: 'List table ids in a BigQuery dataset.',
      parameters: DATASET_PARAMETERS,
      execute: listTableIds,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'get_table_info',
      description: 'Get metadata information about a BigQuery table.',
      parameters: GET_TABLE_INFO_PARAMETERS,
      execute: getTableInfo,
      credentialsConfig,
    }),
  ];
}
