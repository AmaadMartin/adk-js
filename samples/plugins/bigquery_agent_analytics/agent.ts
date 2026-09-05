/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BigQuery agent analytics
 * See docs/guides/plugins/bigquery_agent_analytics_plugin/index.md
 *
 * Streams every lifecycle event of this agent into a BigQuery table, so the
 * run can be queried in SQL. The plugin creates the dataset and the table on
 * first use.
 *
 * Set ADK_ANALYTICS_BUCKET to send content too large to inline to Cloud
 * Storage instead of the row. The plugin does not create the bucket.
 *
 * This sample writes to live BigQuery, so CI does not run it. The README next
 * to this file lists the environment variables and the grants it needs.
 *
 * Run:
 *   npm install @google-cloud/bigquery
 *   export GOOGLE_CLOUD_PROJECT=<your-project>
 *   npm run sample -- samples/plugins/bigquery_agent_analytics/agent.ts
 */

import {
  AnalyticsEventType,
  App,
  BigQueryAgentAnalyticsPlugin,
  FunctionTool,
  LlmAgent,
} from '@google/adk';
import {z} from 'zod';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
if (projectId === undefined || projectId === '') {
  throw new Error(
    'Set GOOGLE_CLOUD_PROJECT to the project holding the dataset.',
  );
}

/** Returns a fixed forecast, so the run needs no weather service. */
const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the current weather for one city.',
  parameters: z.object({city: z.string()}),
  execute: ({city}) => `It is 21 degrees and sunny in ${city}.`,
});

const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId,
  datasetId: process.env['ADK_ANALYTICS_DATASET'] ?? 'agent_analytics',
  tableId: process.env['ADK_ANALYTICS_TABLE'] ?? 'agent_events',
  location: process.env['ADK_ANALYTICS_LOCATION'] ?? 'US',
  config: {
    // A prompt can carry a secret in a shape the pattern redaction does not
    // match, so this sample keeps request bodies out of the table.
    eventDenylist: [AnalyticsEventType.LLM_REQUEST],
    customTags: {sample: 'bigquery_agent_analytics'},
    gcsBucketName: process.env['ADK_ANALYTICS_BUCKET'],
    connectionId: process.env['ADK_ANALYTICS_CONNECTION'],
  },
});

const weatherAgent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-flash-latest',
  instruction: 'Answer weather questions. Call get_weather for a city.',
  tools: [getWeather],
});

export const app = new App({
  name: 'bigquery_agent_analytics_sample',
  rootAgent: weatherAgent,
  plugins: [analytics],
});
