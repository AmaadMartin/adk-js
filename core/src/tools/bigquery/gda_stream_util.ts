/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Conversational Analytics streaming client `ask_data_insights` calls.
 *
 * The API answers a chat request with a JSON array streamed one line at a
 * time, so the reply has to be reassembled as it arrives. Ported from
 * adk-python `src/google/adk/tools/_gda_stream_util.py` (branch `main`).
 */

import {GoogleAuth} from 'google-auth-library';

import {asRecord} from '../../utils/error_utils.js';

import {
  BigQueryCredentialsConfig,
  resolveBigQueryScopes,
} from './bigquery_credentials.js';

/** The global Conversational Analytics endpoint. */
export const GDA_DEFAULT_ENDPOINT =
  'https://geminidataanalytics.googleapis.com';

/** What the API replies with when it has retrieved rows. */
export interface GdaDataRetrieved {
  'Data Retrieved':
    | {
        headers: string[];
        rows: unknown[][];
        summary: string;
      }
    | string;
}

/**
 * Returns the headers one Conversational Analytics call is sent with.
 *
 * @param clientId The client identifier the API tracks the caller by.
 * @param credentialsConfig How to authenticate. Absent means the application
 *     default credentials of the process.
 * @return The headers, including the bearer token.
 * @throws If no access token could be obtained.
 */
export async function getGdaHeaders(
  clientId: string,
  credentialsConfig?: BigQueryCredentialsConfig,
): Promise<Record<string, string>> {
  const auth = new GoogleAuth({
    credentials: credentialsConfig?.credentials,
    keyFilename: credentialsConfig?.keyFilename,
    scopes: resolveBigQueryScopes(credentialsConfig),
  });
  const client = await auth.getClient();
  const {token} = await client.getAccessToken();
  if (!token) {
    throw new Error(
      'Could not obtain an access token for the Conversational Analytics API.',
    );
  }
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Goog-API-Client': clientId,
  };
}

/** Yields the response body one line at a time as it arrives. */
async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      // `split` always yields at least one element, and the last one is the
      // partial line that the next chunk completes.
      const lines = buffer.split('\n');
      buffer = lines[lines.length - 1];
      for (const line of lines.slice(0, -1)) {
        yield line;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer) {
    yield buffer;
  }
}

/** The rows a system message carried, with the schema describing them. */
interface GdaDataResult {
  rows: unknown[];
  schema: unknown;
}

/**
 * Finds the retrieved rows buried in a system message, or `undefined` when
 * the message reports something else.
 */
function extractDataResult(
  message: Record<string, unknown>,
): GdaDataResult | undefined {
  const result = asRecord(
    asRecord(asRecord(message['systemMessage'])?.['data'])?.['result'],
  );
  const rows = result?.['data'];
  return Array.isArray(rows) ? {rows, schema: result?.['schema']} : undefined;
}

/** Reads the column names out of a result, falling back to the first row. */
function resultHeaders(data: GdaDataResult): string[] {
  const fields = asRecord(data.schema)?.['fields'];
  if (Array.isArray(fields)) {
    const headers = fields
      .map((field) => asRecord(field)?.['name'])
      .filter((name): name is string => typeof name === 'string');
    if (headers.length > 0) {
      return headers;
    }
  }
  const firstRow = data.rows.length > 0 ? asRecord(data.rows[0]) : undefined;
  return firstRow ? Object.keys(firstRow) : [];
}

/** Turns a raw result into the compact table the model reads. */
function formatDataRetrieved(
  data: GdaDataResult,
  maxRows: number,
): GdaDataRetrieved {
  const headers = resultHeaders(data);
  const shown = Math.min(data.rows.length, maxRows);

  const rows = data.rows.slice(0, shown).flatMap((row) => {
    // A row the API sent as anything but an object is dropped, as
    // adk-python's `isinstance(r, dict)` check drops it.
    const record = Array.isArray(row) ? undefined : asRecord(row);
    return record ? [headers.map((header) => record[header])] : [];
  });

  return {
    'Data Retrieved': {
      headers,
      rows,
      summary:
        data.rows.length > maxRows
          ? `Showing the first ${shown} of ${data.rows.length} total rows.`
          : `Showing all ${data.rows.length} rows.`,
    },
  };
}

/**
 * Reassembles the streamed JSON array into the messages it carries.
 *
 * The API frames the array across lines, so a line is accumulated until it
 * parses. Only the last retrieved result is kept in full: an earlier one is
 * replaced with a placeholder, because the intermediate rows are large and
 * the model does not need them.
 *
 * @param body The response body.
 * @param maxQueryResultRows How many rows a retrieved result may carry.
 * @return The messages, in the order the API sent them.
 */
export async function readGdaStream(
  body: ReadableStream<Uint8Array>,
  maxQueryResultRows: number,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let accumulator = '';
  let dataMessageIndex = -1;

  for await (const line of readLines(body)) {
    if (!line) {
      continue;
    }
    if (line === '[{') {
      accumulator = '{';
    } else if (line === '}]') {
      accumulator += '}';
    } else if (line === ',') {
      continue;
    } else {
      accumulator += line;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(accumulator);
    } catch {
      continue;
    }
    accumulator = '';

    const message = asRecord(parsed);
    if (!message) {
      messages.push(parsed);
      continue;
    }

    const dataResult = extractDataResult(message);
    if (dataResult) {
      if (dataMessageIndex >= 0) {
        messages[dataMessageIndex] = {
          'Data Retrieved': 'Intermediate result omitted',
        };
      }
      dataMessageIndex = messages.length;
      messages.push(formatDataRetrieved(dataResult, maxQueryResultRows));
      continue;
    }

    const systemMessage = asRecord(message['systemMessage']);
    messages.push(systemMessage ?? message);
  }

  return messages;
}

/**
 * Posts a chat request to the Conversational Analytics API and reads its
 * streamed reply.
 *
 * @param url The `:chat` endpoint of the project and location.
 * @param payload The chat request.
 * @param headers The headers from {@link getGdaHeaders}.
 * @param maxQueryResultRows How many rows a retrieved result may carry.
 * @return The messages the API sent.
 * @throws If the API refuses the request or sends no body.
 */
export async function postGdaStream(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  maxQueryResultRows: number,
): Promise<unknown[]> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `Conversational Analytics API returned ${response.status}: ` +
        `${await response.text()}`,
    );
  }
  if (!response.body) {
    throw new Error('Conversational Analytics API returned no response body.');
  }
  return readGdaStream(response.body, maxQueryResultRows);
}
