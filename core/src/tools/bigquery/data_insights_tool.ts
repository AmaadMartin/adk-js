/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ask_data_insights`, which answers a question about BigQuery tables.
 *
 * Ported from adk-python
 * `src/google/adk/integrations/bigquery/data_insights_tool.py` (branch
 * `main`).
 */

import {z} from 'zod';

import {BaseTool} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';

import {BigQueryToolDeps} from './client.js';
import {
  getGdaEndpoint,
  getGdaHeaders,
  postGdaStream,
} from './gda_stream_util.js';
import {BigQueryToolResult, runBigQueryTool} from './tool_result.js';

/** How the Conversational Analytics API identifies ADK as the caller. */
const GDA_CLIENT_ID = 'GOOGLE_ADK';

/** The location the tool sends its chat requests to. */
const GDA_LOCATION = 'global';

/** How the API must answer, so that the reply stays readable as plain text. */
const SYSTEM_INSTRUCTION = `**INSTRUCTIONS - FOLLOW THESE RULES:**
    1.  **CONTENT:** Your answer should present the supporting data and then provide a conclusion based on that data, including relevant details and observations where possible.
    2.  **ANALYSIS DEPTH:** Your analysis must go beyond surface-level observations. Crucially, you must prioritize metrics that measure impact or outcomes over metrics that simply measure volume or raw counts. For open-ended questions, explore the topic from multiple perspectives to provide a holistic view.
    3.  **OUTPUT FORMAT:** Your entire response MUST be in plain text format ONLY.
    4.  **NO CHARTS:** You are STRICTLY FORBIDDEN from generating any charts, graphs, images, or any other form of visualization.
    `;

/** A BigQuery table the question may be answered from. */
const TABLE_REFERENCE = z.object({
  projectId: z.string().describe('The project holding the table.'),
  datasetId: z.string().describe('The dataset holding the table.'),
  tableId: z.string().describe('The table id.'),
});

/** Arguments of {@link askDataInsights}. */
export const ASK_DATA_INSIGHTS_PARAMETERS = z.object({
  project_id: z.string().describe('The project the inquiry is performed in.'),
  user_query_with_context: z
    .string()
    .describe(
      "The user's request, enriched with the context from the conversation " +
        'that resolves any ambiguity in a follow-up question.',
    ),
  table_references: z
    .array(TABLE_REFERENCE)
    .describe('The BigQuery tables the question may be answered from.'),
});

/** What {@link askDataInsights} returns when the API answered. */
export interface AskDataInsightsResult {
  status: 'SUCCESS';
  /** One entry per step the API took: generated SQL, rows, the answer. */
  response: unknown[];
}

/**
 * Answers a question about BigQuery tables in natural language.
 *
 * The Conversational Analytics API writes and runs the SQL itself and
 * streams back a log of what it did, which this tool returns whole so that
 * the model can quote the supporting data alongside the answer.
 *
 * @param input The question and the tables it may be answered from.
 * @param deps The clients and settings of the owning toolset.
 * @return The API's steps, or the failure envelope.
 */
export async function askDataInsights(
  input: z.infer<typeof ASK_DATA_INSIGHTS_PARAMETERS>,
  deps: BigQueryToolDeps,
): Promise<BigQueryToolResult<AskDataInsightsResult>> {
  return runBigQueryTool(async () => {
    const headers = await getGdaHeaders(GDA_CLIENT_ID, deps.credentialsConfig);
    const url =
      `${getGdaEndpoint(GDA_LOCATION)}/v1/projects/${input.project_id}` +
      `/locations/${GDA_LOCATION}:chat`;

    const payload = {
      messages: [{userMessage: {text: input.user_query_with_context}}],
      inlineContext: {
        datasourceReferences: {
          bq: {tableReferences: input.table_references},
        },
        systemInstruction: SYSTEM_INSTRUCTION,
      },
      clientIdEnum: GDA_CLIENT_ID,
    };

    const response = await postGdaStream(
      url,
      payload,
      headers,
      deps.settings.maxQueryResultRows,
    );
    return {status: 'SUCCESS', response};
  });
}

/**
 * Builds the `ask_data_insights` tool.
 *
 * @param deps The clients and settings of the owning toolset.
 * @return The tool.
 */
export function createDataInsightsTool(deps: BigQueryToolDeps): BaseTool {
  return new FunctionTool({
    name: 'ask_data_insights',
    description:
      'Answer a question about the structured data in one or more BigQuery ' +
      'tables, in natural language. The tool writes and runs the SQL itself ' +
      'and returns a log of every step it took, ending in a plain text ' +
      'answer. Use it for data analysis over named tables.',
    parameters: ASK_DATA_INSIGHTS_PARAMETERS,
    execute: (input) => askDataInsights(input, deps),
  });
}
