/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Conversational Analytics chat stream `ask_data_insights` reads.
 *
 * It is the part of adk-python's `tools/_gda_stream_util.py` that the
 * BigQuery tool uses: the host for a location, the accumulator that turns the
 * streamed JSON array back into messages, and a `fetch`-backed session. The
 * request/response half of that module belongs to the data agent tools, which
 * adk-js does not have yet, so it is left out.
 */

import type {AuthClient} from 'google-auth-library';

import {isRecord} from '../../utils/record_utils.js';

/** The client identifier the Conversational Analytics API is told to record. */
export const GDA_CLIENT_ID = 'GOOGLE_ADK';

/** The result key holding the rows the answering agent read. */
export const DATA_RETRIEVED_KEY = 'Data Retrieved';

/** What an earlier data message is replaced with once a later one arrives. */
export const INTERMEDIATE_RESULT_OMITTED = 'Intermediate result omitted';

/** The host serving every location that has no regional host of its own. */
const GDA_DEFAULT_ENDPOINT = 'https://geminidataanalytics.googleapis.com';

/** Locations served by a Regional Endpoint Product host. */
const REP_LOCATIONS: readonly string[] = ['eu', 'us'];

/** The location that means "not regional". */
export const GLOBAL_LOCATION = 'global';

/**
 * Returns the Conversational Analytics host for a location.
 *
 * @param location The Google Cloud location, for example `eu`, `us` or
 *     `global`. Anything else selects a regional host.
 * @return The host, with its scheme.
 */
export function resolveGdaEndpoint(location?: string): string {
  const normalized = (location ?? '').toLowerCase().trim();
  if (!normalized || normalized === GLOBAL_LOCATION) {
    return GDA_DEFAULT_ENDPOINT;
  }
  if (REP_LOCATIONS.includes(normalized)) {
    return `https://geminidataanalytics.${normalized}.rep.googleapis.com`;
  }
  return `https://geminidataanalytics-${normalized}.googleapis.com`;
}

/** The headers every Conversational Analytics request carries. */
export function gdaHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Goog-API-Client': GDA_CLIENT_ID,
  };
}

/**
 * Posts a chat request and yields the reply one line at a time.
 *
 * Narrow on purpose: a test supplies its own implementation and asserts the
 * exact URL, headers and payload the tool built.
 */
export type GdaStream = (
  url: string,
  payload: unknown,
  headers: Record<string, string>,
) => AsyncIterable<string>;

/**
 * Finds the query result buried in a streamed system message.
 *
 * @param message One decoded stream message.
 * @return The result object when it carries a row array, else `undefined`.
 */
export function extractDataResult(
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const systemMessage = message['systemMessage'];
  if (!isRecord(systemMessage)) {
    return undefined;
  }
  const data = systemMessage['data'];
  if (!isRecord(data)) {
    return undefined;
  }
  const result = data['result'];
  if (!isRecord(result)) {
    return undefined;
  }
  return Array.isArray(result['data']) ? result : undefined;
}

/** Reads the column names a result declares, ignoring unnamed fields. */
function resultHeaders(
  result: Record<string, unknown>,
  rows: readonly unknown[],
): string[] {
  const schema = result['schema'];
  const fields =
    isRecord(schema) && Array.isArray(schema['fields']) ? schema['fields'] : [];
  const headers = fields.flatMap((field) =>
    isRecord(field) && typeof field['name'] === 'string' ? [field['name']] : [],
  );
  if (headers.length > 0) {
    return headers;
  }
  const firstRow = rows[0];
  return isRecord(firstRow) ? Object.keys(firstRow) : [];
}

/**
 * Reshapes a query result into the compact table the model reads.
 *
 * @param result The result object, as {@link extractDataResult} returns it.
 * @param maxRows How many rows to keep.
 * @return The `Data Retrieved` message.
 */
export function formatDataRetrieved(
  result: Record<string, unknown>,
  maxRows: number,
): Record<string, unknown> {
  const rawRows = Array.isArray(result['data']) ? result['data'] : [];
  const headers = resultHeaders(result, rawRows);
  const totalRows = rawRows.length;
  const shownRows = Math.min(totalRows, maxRows);
  const rows = rawRows
    .slice(0, shownRows)
    .flatMap((row) =>
      isRecord(row) ? [headers.map((header) => row[header])] : [],
    );
  const summary =
    totalRows > maxRows
      ? `Showing the first ${shownRows} of ${totalRows} total rows.`
      : `Showing all ${totalRows} rows.`;
  return {[DATA_RETRIEVED_KEY]: {headers, rows, summary}};
}

/**
 * Posts a chat request and decodes the streamed reply into messages.
 *
 * The wire format is one JSON array streamed a line at a time, so lines are
 * accumulated until they parse. Only the newest query result keeps its rows;
 * an earlier one is replaced, because the model only needs the latest table.
 *
 * @param stream The transport to post through.
 * @param url The chat endpoint.
 * @param payload The chat request body.
 * @param headers Headers to send with the request.
 * @param maxQueryResultRows How many rows a result message may carry.
 * @return The decoded messages, in the order the API sent them.
 */
export async function streamChat(
  stream: GdaStream,
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  maxQueryResultRows: number,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let accumulator = '';
  let dataMessageIndex = -1;

  for await (const line of stream(url, payload, headers)) {
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

    let message: unknown;
    try {
      message = JSON.parse(accumulator);
    } catch {
      continue;
    }
    accumulator = '';

    if (!isRecord(message)) {
      messages.push(message);
      continue;
    }

    const dataResult = extractDataResult(message);
    if (dataResult) {
      if (dataMessageIndex >= 0) {
        messages[dataMessageIndex] = {
          [DATA_RETRIEVED_KEY]: INTERMEDIATE_RESULT_OMITTED,
        };
      }
      dataMessageIndex = messages.length;
      messages.push(formatDataRetrieved(dataResult, maxQueryResultRows));
    } else if (isRecord(message['systemMessage'])) {
      messages.push(message['systemMessage']);
    } else {
      messages.push(message);
    }
  }
  return messages;
}

/** Splits a byte stream into lines, dropping the line terminators. */
async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      for (
        let newline = buffer.indexOf('\n');
        newline >= 0;
        newline = buffer.indexOf('\n')
      ) {
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      yield buffer.replace(/\r$/, '');
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Returns a stream authorized by a google-auth-library client.
 *
 * The client is held for the length of one tool call: it mints the
 * `Authorization` header for the request, so the tool does not re-resolve the
 * credential.
 *
 * @param authClient The credential to authorize with, or `undefined` to send
 *     the request unauthenticated.
 * @return The transport {@link streamChat} posts through.
 */
export function createGdaStream(authClient?: AuthClient): GdaStream {
  return async function* stream(url, payload, headers) {
    const merged = authClient
      ? await authClient.getRequestHeaders(url)
      : new Headers();
    for (const [name, value] of Object.entries(headers)) {
      merged.set(name, value);
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: merged,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(
        `API returned error status: ${response.status} ${await response.text()}`,
      );
    }
    if (response.body) {
      yield* readLines(response.body);
    }
  };
}
