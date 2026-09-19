/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BigQuery toolset: read metadata and run a query
 *
 * The agent lists the datasets of a project, describes a table and runs a
 * `SELECT`. The toolset is read-only by default, so the model cannot write.
 *
 * Setup:
 *   npm install @google-cloud/bigquery @google-cloud/dataplex
 *   gcloud auth application-default login
 *   export GOOGLE_CLOUD_PROJECT=<your project id>
 *
 * Run:
 *   npm run sample -- samples/tools/bigquery/agent.ts
 * Ask: "list the datasets in my project", then
 *      "how many rows are in bigquery-public-data.ml_datasets.penguins?"
 */

import {BigQueryToolset, LlmAgent} from '@google/adk';

const project = process.env['GOOGLE_CLOUD_PROJECT'] ?? '<your project id>';

export const rootAgent = new LlmAgent({
  name: 'bigquery_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers questions about BigQuery data and metadata.',
  instruction:
    `Answer questions about BigQuery data in the project ${project}. ` +
    'Use list_dataset_ids and list_table_ids to find the data, ' +
    'get_table_info to read a schema, and execute_sql to query it. ' +
    'Always report the SQL you ran.',
  tools: [new BigQueryToolset({bigqueryToolConfig: {maxQueryResultRows: 20}})],
});
