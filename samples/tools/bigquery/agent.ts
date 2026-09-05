/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answering questions about BigQuery data.
 *
 * `BigQueryToolset` gives the agent the eleven first-party BigQuery tools. By
 * default `execute_sql` accepts only SELECT, so the agent can read the data
 * but cannot change it. See docs/guides/tools/bigquery_toolset/index.md.
 *
 * Install (the two SDKs are optional peer dependencies):
 *   npm install @google/adk @google-cloud/bigquery @google-cloud/dataplex
 *
 * Run (makes real API calls, billed to GOOGLE_CLOUD_PROJECT):
 *   export GOOGLE_CLOUD_PROJECT=<your-project>
 *   gcloud auth application-default login
 *   npm run sample -- samples/tools/bigquery/agent.ts
 */

import {LlmAgent} from '@google/adk';
import {BigQueryToolset} from '@google/adk/integrations/bigquery';

const project = process.env['GOOGLE_CLOUD_PROJECT'];
if (!project) {
  throw new Error('Set GOOGLE_CLOUD_PROJECT to the project to query.');
}

export const rootAgent = new LlmAgent({
  name: 'bigquery_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers questions about BigQuery data and metadata.',
  instruction:
    `Answer questions about BigQuery data in the project ${project}. ` +
    'Find the dataset and the table with list_dataset_ids, list_table_ids ' +
    'and get_table_info before you write a query. Then read the data with ' +
    'execute_sql. Say so if a question needs a write, because this agent is ' +
    'read-only.',
  tools: [new BigQueryToolset({bigqueryToolConfig: {maxQueryResultRows: 20}})],
});
