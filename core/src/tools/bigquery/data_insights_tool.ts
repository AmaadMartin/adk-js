/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {BigQueryToolConfig} from './config.js';
import {BigQueryCredentialsConfig} from './credentials.js';

const GDA_CLIENT_ID = 'GOOGLE_ADK';

interface StreamError {
  code?: string | number;
  message?: string;
}

interface TextResponse {
  parts?: string[];
}

interface SchemaResponse {
  query?: {question?: string};
  result?: {
    datasources?: Array<{
      bigqueryTableReference?: {
        projectId?: string;
        datasetId?: string;
        tableId?: string;
      };
      schema?: {
        fields?: Array<{
          name?: string;
          type?: string;
          description?: string;
          mode?: string;
        }>;
      };
    }>;
  };
}

interface DataResponse {
  query?: {name?: string; question?: string};
  generatedSql?: string;
  result?: {
    schema?: {
      fields?: Array<{name: string}>;
    };
    data?: Array<Record<string, unknown>>;
  };
}

/**
 * Answers questions about structured data in BigQuery tables using natural language.
 */
export async function askDataInsights(
  args: {
    projectId: string;
    userQueryWithContext: string;
    tableReferences: Array<Record<string, string>>;
  },
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: BigQueryToolConfig,
  context?: Context,
): Promise<
  | {status: string; response: Record<string, unknown>[]}
  | {status: string; error_details: string}
> {
  const {projectId, userQueryWithContext, tableReferences} = args;
  const settings = toolConfig || {maxQueryResultRows: 50};

  try {
    let token: string | undefined;

    if (credentialsConfig?.credentials?.token) {
      token = credentialsConfig.credentials.token;
    } else if (credentialsConfig?.externalAccessTokenKey && context) {
      token = context.state.get<string>(
        credentialsConfig.externalAccessTokenKey,
      );
    } else if (context) {
      const {GoogleAuth} = await import('google-auth-library');
      const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      token = tokenResponse.token || undefined;
    }

    if (!token) {
      return {
        status: 'ERROR',
        error_details: 'askDataInsights requires a valid access token.',
      };
    }

    const location = 'global';
    const url = `https://geminidataanalytics.googleapis.com/v1beta/projects/${projectId}/locations/${location}:chat`;

    const instructions = `**INSTRUCTIONS - FOLLOW THESE RULES:**
    1.  **CONTENT:** Your answer should present the supporting data and then provide a conclusion based on that data, including relevant details and observations where possible.
    2.  **ANALYSIS DEPTH:** Your analysis must go beyond surface-level observations. Crucially, you must prioritize metrics that measure impact or outcomes over metrics that simply measure volume or raw counts. For open-ended questions, explore the topic from multiple perspectives to provide a holistic view.
    3.  **OUTPUT FORMAT:** Your entire response MUST be in plain text format ONLY.
    4.  **NO CHARTS:** You are STRICTLY FORBIDDEN from generating any charts, graphs, images, or any other form of visualization.
    `;

    const payload = {
      project: `projects/${projectId}`,
      messages: [{userMessage: {text: userQueryWithContext}}],
      inlineContext: {
        datasourceReferences: {
          bq: {tableReferences: tableReferences},
        },
        systemInstruction: instructions,
        options: {chart: {image: {noImage: {}}}},
      },
      clientIdEnum: GDA_CLIENT_ID,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Goog-API-Client': GDA_CLIENT_ID,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: 'ERROR',
        error_details: `API call failed with status ${response.status}: ${errorText}`,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable.');
    }

    const decoder = new TextDecoder('utf-8');
    let accumulator = '';
    const messages: Record<string, unknown>[] = [];

    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, {stream: true});
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line) continue;

        const decodedLine = line.trim();

        if (decodedLine === '[{') {
          accumulator = '{';
        } else if (decodedLine === '}]') {
          accumulator += '}';
        } else if (decodedLine === ',') {
          continue;
        } else {
          accumulator += decodedLine;
        }

        if (!isJson(accumulator)) {
          continue;
        }

        const dataJson = JSON.parse(accumulator);
        if (!dataJson.systemMessage) {
          if (dataJson.error) {
            appendMessage(messages, handleError(dataJson.error));
          }
          continue;
        }

        const systemMessage = dataJson.systemMessage;
        if (systemMessage.text) {
          appendMessage(messages, handleTextResponse(systemMessage.text));
        } else if (systemMessage.schema) {
          appendMessage(messages, handleSchemaResponse(systemMessage.schema));
        } else if (systemMessage.data) {
          appendMessage(
            messages,
            handleDataResponse(
              systemMessage.data,
              settings.maxQueryResultRows || 50,
            ),
          );
        }
        accumulator = '';
      }
    }

    return {status: 'SUCCESS', response: messages};
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: ex instanceof Error ? ex.message : String(ex),
    };
  }
}

function isJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

function appendMessage(
  messages: Record<string, unknown>[],
  newMessage: Record<string, unknown>,
) {
  if (!newMessage || Object.keys(newMessage).length === 0) {
    return;
  }

  if (messages.length > 0 && messages[messages.length - 1]['Data Retrieved']) {
    messages.pop();
  }

  messages.push(newMessage);
}

function handleError(error: StreamError) {
  return {
    Error: {
      Code: error.code || 'N/A',
      Message: error.message || 'No message provided.',
    },
  };
}

function handleTextResponse(resp: TextResponse) {
  const parts = resp.parts || [];
  return {Answer: parts.join('')};
}

function handleSchemaResponse(resp: SchemaResponse) {
  if (resp.query) {
    return {Question: resp.query.question || ''};
  } else if (resp.result) {
    const datasources = resp.result.datasources || [];
    const formattedSources = datasources.map((ds) => {
      const sourceName = `${ds.bigqueryTableReference?.projectId}.${ds.bigqueryTableReference?.datasetId}.${ds.bigqueryTableReference?.tableId}`;
      const fields = ds.schema?.fields || [];
      const rows = fields.map((field) => [
        field.name || '',
        field.type || '',
        field.description || '',
        field.mode || '',
      ]);
      return {
        source_name: sourceName,
        schema: {
          headers: ['Column', 'Type', 'Description', 'Mode'],
          rows,
        },
      };
    });
    return {'Schema Resolved': formattedSources};
  }
  return {};
}

function handleDataResponse(resp: DataResponse, maxQueryResultRows: number) {
  if (resp.query) {
    return {
      'Retrieval Query': {
        'Query Name': resp.query.name || 'N/A',
        'Question': resp.query.question || 'N/A',
      },
    };
  } else if (resp.generatedSql) {
    return {'SQL Generated': resp.generatedSql};
  } else if (resp.result) {
    const schema = resp.result.schema || {};
    const fields = schema.fields || [];
    const headers = fields.map((f) => f.name);

    const allRows = resp.result.data || [];
    const totalRows = allRows.length;

    const compactRows = allRows.slice(0, maxQueryResultRows).map((rowDict) => {
      return headers.map((header) => rowDict[header]);
    });

    let summaryString = `Showing all ${totalRows} rows.`;
    if (totalRows > maxQueryResultRows) {
      summaryString = `Showing the first ${compactRows.length} of ${totalRows} total rows.`;
    }

    return {
      'Data Retrieved': {
        headers,
        rows: compactRows,
        summary: summaryString,
      },
    };
  }
  return {};
}
