/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient} from 'google-auth-library';
import {isRecord} from '../../utils/object_utils.js';

/** The client identifier the Conversational Analytics API is told to record. */
export const GDA_CLIENT_ID = 'GOOGLE_ADK';

/** Budget for a single request to the Conversational Analytics API. */
export const GDA_REQUEST_TIMEOUT_SECONDS = 30;

/** Poll statuses that are worth another attempt inside the same deadline. */
export const RETRYABLE_STATUS_CODES: readonly number[] = [
  429, 500, 502, 503, 504,
];

/** The result key holding the rows a data agent read. */
export const DATA_RETRIEVED_KEY = 'Data Retrieved';

/** What an earlier data message is replaced with once a later one arrives. */
export const INTERMEDIATE_RESULT_OMITTED = 'Intermediate result omitted';

const GDA_DEFAULT_ENDPOINT = 'https://geminidataanalytics.googleapis.com';

/** Locations served by a Regional Endpoint Product host rather than a regional one. */
const REP_LOCATIONS: readonly string[] = ['eu', 'us'];

/** The location that means "not regional". */
export const GLOBAL_LOCATION = 'global';

/** Which Conversational Analytics host a call goes to. */
export interface GdaEndpointOptions {
  /**
   * The Google Cloud location of the data agent, for example `eu`, `us` or
   * `global`. Selects a regional host.
   */
  location?: string;
  /** A host that replaces the location-derived one entirely. */
  apiEndpoint?: string;
}

/** One HTTP exchange with the Conversational Analytics API. */
export interface GdaRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  /** Request budget in seconds. */
  timeoutSeconds: number;
  /** Query parameters appended to `url`. */
  params?: Record<string, string>;
  /** The JSON request body, when the method carries one. */
  body?: unknown;
}

/** What the API answered. Parse `text` with `JSON.parse` to read the body. */
export interface GdaResponse {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * The transport the data agent tools speak to the API through.
 *
 * Narrow on purpose: a test supplies its own implementation and asserts the
 * exact URL, headers, timeout and payload each tool builds.
 */
export interface GdaSession {
  request(request: GdaRequest): Promise<GdaResponse>;
  /**
   * Streams a chat response one line at a time.
   *
   * @throws Error if the API answers with a non-2xx status.
   */
  streamLines(
    url: string,
    payload: unknown,
    headers: Record<string, string>,
  ): AsyncIterable<string>;
}

/** An authorized session and the host it was opened against. */
export interface GdaSessionHandle {
  session: GdaSession;
  endpoint: string;
}

/** Opens an authorized session against the host `options` selects. */
export type GdaSessionFactory = (
  options: GdaEndpointOptions,
) => Promise<GdaSessionHandle>;

/**
 * Returns the Conversational Analytics host for a location.
 *
 * @param options The location, or an endpoint that overrides it.
 * @return The host, always with a scheme.
 */
export function resolveGdaEndpoint(options: GdaEndpointOptions = {}): string {
  const {location, apiEndpoint} = options;
  if (apiEndpoint) {
    return apiEndpoint.includes('://') ? apiEndpoint : `https://${apiEndpoint}`;
  }
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
 * @param session The authorized session to stream through.
 * @param url The chat endpoint.
 * @param payload The chat request body.
 * @param headers Headers to send with the request.
 * @param maxQueryResultRows How many rows a result message may carry.
 * @return The decoded messages, in the order the API sent them.
 */
export async function streamChat(
  session: GdaSession,
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  maxQueryResultRows: number,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let accumulator = '';
  let dataMessageIndex = -1;

  for await (const line of session.streamLines(url, payload, headers)) {
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

/** Appends query parameters to a URL. */
function withParams(url: string, params?: Record<string, string>): string {
  if (!params) {
    return url;
  }
  const target = new URL(url);
  for (const [name, value] of Object.entries(params)) {
    target.searchParams.set(name, value);
  }
  return target.toString();
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
 * A session backed by `fetch`, authorized by a google-auth-library client.
 *
 * The client is held for the length of one tool call: it mints the
 * `Authorization` header for every request the call makes, so the tools do
 * not re-resolve the credential per request.
 */
class FetchGdaSession implements GdaSession {
  constructor(private readonly authClient?: AuthClient) {}

  async request(request: GdaRequest): Promise<GdaResponse> {
    const url = withParams(request.url, request.params);
    const response = await fetch(url, {
      method: request.method,
      headers: await this.headers(url, request.headers),
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutSeconds * 1000),
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }

  async *streamLines(
    url: string,
    payload: unknown,
    headers: Record<string, string>,
  ): AsyncGenerator<string> {
    const response = await fetch(url, {
      method: 'POST',
      headers: await this.headers(url, headers),
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
  }

  /** Merges the caller's headers over the credential's own. */
  private async headers(
    url: string,
    headers: Record<string, string>,
  ): Promise<Headers> {
    const merged = this.authClient
      ? await this.authClient.getRequestHeaders(url)
      : new Headers();
    for (const [name, value] of Object.entries(headers)) {
      merged.set(name, value);
    }
    return merged;
  }
}

/**
 * Opens an authorized session against the Conversational Analytics API.
 *
 * @param authClient The credential to authorize with, or `undefined` to send
 *   the requests unauthenticated.
 * @param options Which host to talk to.
 * @return The session and the host it targets.
 */
export async function createGdaSession(
  authClient: AuthClient | undefined,
  options: GdaEndpointOptions = {},
): Promise<GdaSessionHandle> {
  return {
    session: new FetchGdaSession(authClient),
    endpoint: resolveGdaEndpoint(options),
  };
}
