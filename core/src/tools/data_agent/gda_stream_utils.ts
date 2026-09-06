/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transport helpers for the Gemini Data Analytics (GDA) REST API: endpoint
 * resolution, and the reader that turns a streaming chat response into the
 * message list the model sees.
 */

import {asRecord} from '../../utils/object_utils.js';

/** Value sent in the `X-Goog-API-Client` header and the chat `clientIdEnum`. */
export const GDA_CLIENT_ID = 'GOOGLE_ADK';

/** The location used when neither the settings nor a resource name supply one. */
export const GLOBAL_LOCATION = 'global';

/** Endpoint used for the `global` location. */
const GDA_GLOBAL_ENDPOINT = 'https://geminidataanalytics.googleapis.com';

/** Locations served by a regional endpoint program (`.rep.`) host. */
const REP_LOCATIONS = new Set(['eu', 'us']);

/**
 * Locations that may be interpolated into an endpoint host.
 *
 * A location can reach this module from a model-supplied `data_agent_name`, so
 * it is attacker-influenced. Characters such as `@`, `#`, `/` and `:` would end
 * the authority component and send the request — and its bearer token — to
 * another host, so only the characters a real Google Cloud location uses are
 * accepted.
 */
const ALLOWED_LOCATION = /^[a-z0-9-]+$/;

/** Key holding the table extracted from a data message. Model-facing. */
const DATA_RETRIEVED_KEY = 'Data Retrieved';

/** Value that replaces a data table superseded by a later one. Model-facing. */
const INTERMEDIATE_RESULT_OMITTED = 'Intermediate result omitted';

/** Selects the Gemini Data Analytics host. */
export interface GdaEndpointOptions {
  /** The Google Cloud location of the data agent. */
  location?: string;
  /** A custom endpoint, with or without a scheme. Overrides the location. */
  apiEndpoint?: string;
}

/** The `result` payload of a data message: the rows plus an optional schema. */
export interface GdaDataResult {
  data: unknown[];
  schema?: unknown;
}

/** The table a data message contributes to the model-facing message list. */
export interface GdaDataTable {
  headers: string[];
  rows: unknown[][];
  summary: string;
}

/**
 * Parses `text` as JSON. Returns `undefined` when `text` is not yet a complete
 * JSON document, so a caller can keep accumulating lines.
 */
function tryParseJson(text: string): {value: unknown} | undefined {
  try {
    return {value: JSON.parse(text) as unknown};
  } catch {
    return undefined;
  }
}

/**
 * Resolves the Gemini Data Analytics host for a location or custom endpoint.
 *
 * `apiEndpoint` is deliberately not constrained: it is set by the agent author
 * in `DataAgentToolConfig` and never by the model, and pointing the tools at a
 * private or test endpoint is a supported use. A `location` is constrained,
 * because it can be derived from a model-supplied resource name.
 *
 * @param options The location and custom endpoint to resolve.
 * @return The endpoint origin, without a trailing slash.
 * @throws If the location contains anything outside {@link ALLOWED_LOCATION}.
 */
export function getGdaEndpoint(options: GdaEndpointOptions = {}): string {
  const {apiEndpoint} = options;
  if (apiEndpoint) {
    return apiEndpoint.includes('://') ? apiEndpoint : `https://${apiEndpoint}`;
  }

  const location = (options.location ?? '').toLowerCase().trim();
  if (!location || location === GLOBAL_LOCATION) {
    return GDA_GLOBAL_ENDPOINT;
  }
  if (!ALLOWED_LOCATION.test(location)) {
    throw new Error(
      `Invalid Data Agent location ${JSON.stringify(location)}: a location ` +
        'may contain only letters, digits and hyphens.',
    );
  }
  if (REP_LOCATIONS.has(location)) {
    return `https://geminidataanalytics.${location}.rep.googleapis.com`;
  }
  return `https://geminidataanalytics-${location}.googleapis.com`;
}

/**
 * Throws when `response` carries a non-2xx status, mirroring the
 * `raise_for_status()` call the Python implementation makes.
 *
 * @param response The response to check.
 * @param url The requested URL, named in the error so a caller that issues
 *     more than one request can tell which one failed.
 */
export function throwIfNotOk(response: Response, url: string): void {
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} for ${url}`,
    );
  }
}

/** Drops the carriage return of a CRLF line ending. */
function stripCarriageReturn(line: string): string {
  return line.replace(/\r$/, '');
}

/**
 * Yields the newline-delimited lines of a response body, decoding the bytes as
 * they arrive.
 */
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
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        yield stripCarriageReturn(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    yield stripCarriageReturn(buffer + decoder.decode());
  } finally {
    // Releases the lock when the consumer abandons the stream early, so the
    // response body can still be cancelled by its owner.
    reader.releaseLock();
  }
}

/**
 * Reads a streaming Gemini Data Analytics chat response into the list of
 * messages the model sees.
 *
 * The wire format is a JSON array streamed one fragment per line. Fragments
 * are accumulated until they parse, then each message is either passed through,
 * unwrapped from its `systemMessage`, or — for a data message — converted into
 * a table. Only the last data table keeps its rows; earlier ones are replaced
 * with a placeholder so the transcript stays small.
 *
 * @param response The streaming chat response.
 * @param maxQueryResultRows Rows to keep from the final data table.
 * @return The messages read from the stream, in order.
 */
export async function readGdaStream(
  response: Response,
  maxQueryResultRows: number,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let accumulator = '';
  let dataMessageIndex = -1;

  // A bodyless response carries no messages, and matches what Python's
  // `iter_lines()` yields for one.
  if (!response.body) {
    return messages;
  }

  for await (const line of readLines(response.body)) {
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

    const parsed = tryParseJson(accumulator);
    if (!parsed) {
      continue;
    }
    accumulator = '';

    const message = asRecord(parsed.value);
    if (!message) {
      messages.push(parsed.value);
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
      continue;
    }

    messages.push(asRecord(message['systemMessage']) ?? message);
  }

  return messages;
}

/**
 * Extracts `systemMessage.data.result` from a stream message when it holds a
 * row array.
 *
 * @param message The parsed stream message.
 * @return The result payload, or `undefined` for any other message shape.
 */
export function extractDataResult(message: unknown): GdaDataResult | undefined {
  const systemMessage = asRecord(asRecord(message)?.['systemMessage']);
  const data = asRecord(systemMessage?.['data']);
  const result = asRecord(data?.['result']);
  const rows = result?.['data'];
  return result && Array.isArray(rows) ? {...result, data: rows} : undefined;
}

/**
 * Converts a data result into the flat table the model reads.
 *
 * @param result The result payload from {@link extractDataResult}.
 * @param maxRows Maximum number of rows to keep.
 * @return The table, wrapped under the model-facing `Data Retrieved` key.
 */
export function formatDataRetrieved(
  result: GdaDataResult,
  maxRows: number,
): Record<string, GdaDataTable> {
  const rawData = result.data;
  const schemaFields = asRecord(result.schema)?.['fields'];
  const headers = (Array.isArray(schemaFields) ? schemaFields : [])
    .map((field) => asRecord(field)?.['name'])
    .filter((name): name is string => typeof name === 'string');

  const firstRow = asRecord(rawData[0]);
  if (headers.length === 0 && firstRow) {
    headers.push(...Object.keys(firstRow));
  }

  const totalRows = rawData.length;
  const shownRows = Math.min(totalRows, maxRows);
  const rows: unknown[][] = [];
  for (const rawRow of rawData.slice(0, shownRows)) {
    const row = asRecord(rawRow);
    if (row) {
      rows.push(headers.map((header) => row[header]));
    }
  }

  const summary =
    totalRows > maxRows
      ? `Showing the first ${shownRows} of ${totalRows} total rows.`
      : `Showing all ${totalRows} rows.`;

  return {[DATA_RETRIEVED_KEY]: {headers, rows, summary}};
}
