/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AuthClient} from 'google-auth-library';

import {GoogleToolStatus} from '../../tools/google_tool.js';

import {
  GDA_CLIENT_ID,
  GLOBAL_LOCATION,
  createGdaStream,
  gdaHeaders,
  resolveGdaEndpoint,
  streamChat,
} from './gda_stream.js';

import {BigQueryToolSettings} from './config.js';

/** How the answering agent is told to reply. */
const DATA_INSIGHTS_INSTRUCTIONS = `**INSTRUCTIONS - FOLLOW THESE RULES:**
    1.  **CONTENT:** Your answer should present the supporting data and then provide a conclusion based on that data, including relevant details and observations where possible.
    2.  **ANALYSIS DEPTH:** Your analysis must go beyond surface-level observations. Crucially, you must prioritize metrics that measure impact or outcomes over metrics that simply measure volume or raw counts. For open-ended questions, explore the topic from multiple perspectives to provide a holistic view.
    3.  **OUTPUT FORMAT:** Your entire response MUST be in plain text format ONLY.
    4.  **NO CHARTS:** You are STRICTLY FORBIDDEN from generating any charts, graphs, images, or any other form of visualization.
    `;

/** One BigQuery table the question may be answered from. */
export interface BigQueryTableReference {
  projectId: string;
  datasetId: string;
  tableId: string;
}

/** What {@link askDataInsights} needs from the model. */
export interface AskDataInsightsOptions {
  /** The project the inquiry is performed in. */
  projectId: string;
  /** The question, carrying enough conversation history to be unambiguous. */
  userQueryWithContext: string;
  /** The tables the question may be answered from. */
  tableReferences: BigQueryTableReference[];
}

/** What {@link askDataInsights} answers with. */
export interface AskDataInsightsResponse {
  status: GoogleToolStatus.SUCCESS;
  /** One entry per step the answering agent took, in order. */
  response: unknown[];
}

/**
 * Answers a question about BigQuery tables in natural language.
 *
 * The Conversational Analytics API generates and runs the SQL, then explains
 * the result. The reply is the whole log of that work: the statements it ran,
 * the rows it read, and the answer it settled on.
 *
 * @param options The question and the tables that may answer it.
 * @param settings The settings the owning toolset was configured with.
 * @param credentials The credential to authorize the call with.
 * @return The steps the answering agent took.
 * @throws {Error} If the API answers with a non-2xx status.
 */
export async function askDataInsights(
  options: AskDataInsightsOptions,
  settings: BigQueryToolSettings,
  credentials?: AuthClient,
): Promise<AskDataInsightsResponse> {
  const endpoint = resolveGdaEndpoint(GLOBAL_LOCATION);
  const url = `${endpoint}/v1/projects/${options.projectId}/locations/${GLOBAL_LOCATION}:chat`;
  const payload = {
    messages: [{userMessage: {text: options.userQueryWithContext}}],
    inlineContext: {
      datasourceReferences: {bq: {tableReferences: options.tableReferences}},
      systemInstruction: DATA_INSIGHTS_INSTRUCTIONS,
    },
    clientIdEnum: GDA_CLIENT_ID,
  };
  const response = await streamChat(
    createGdaStream(credentials),
    url,
    payload,
    gdaHeaders(),
    settings.maxQueryResultRows,
  );
  return {status: GoogleToolStatus.SUCCESS, response};
}
