/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ambient capture of the HTTP exchanges behind an operation, for an operator
 * who has to see what actually went over the wire.
 *
 * A caller opens a buffer around an operation; any producer running inside
 * that operation appends to it, without the buffer being threaded through the
 * calls in between. A capture is scoped to its own async context, so two
 * concurrent captures never see each other's entries. Outside a capture every
 * append is a no-op.
 *
 * There are two capture surfaces here, one per record shape:
 *
 * - {@link captureHttpDebug} and {@link instrumentFetch} record an
 *   {@link HttpDebugRecord}, whose field names match adk-python.
 * - {@link runWithHttpDebugCapture} and {@link describeHttpExchange} record an
 *   {@link HttpExchange}, in adk-js field names, and
 *   {@link appendHttpDebugInfo} persists it on an invocation.
 *
 * A producer can install both, as the MCP transport does: each records only
 * while its own capture is open, so an operation under both reports to both.
 *
 * A credential in the URL or in a header is masked, and bodies are truncated
 * at {@link MAX_LOG_BODY_LENGTH}, as each exchange is recorded, because a
 * capture ends up persisted on an event.
 */

import {AsyncLocalStorage} from 'node:async_hooks';

import {formatError, truncateBody} from './error_utils.js';
import {logger} from './logger.js';
import {redactUriPassword} from './redact_uri.js';

/**
 * Header names whose value is a credential. Compared lower-case. A superset of
 * the four that adk-python's `_redact_headers` covers, adding the other header
 * names in common use for an API key.
 */
const SENSITIVE_HEADERS = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

/** Value written in place of a credential-bearing header. */
const REDACTED = '<redacted>';

/** Recorded in place of an SSE body, which must not be read. */
const SSE_BODY_PLACEHOLDER = '<SSE stream>';

/** Content type of a Server-Sent Events response. */
const SSE_CONTENT_TYPE = 'text/event-stream';

/** Recorded when the response body cannot be read. */
const UNREADABLE_BODY = '<failed to read body>';

/**
 * `RequestInit`, reached through the global `fetch`.
 *
 * `RequestInit` is a type-only global, which ESLint's `no-undef` reports as an
 * undefined name; `fetch` is a value it can see.
 */
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/** The shape of `fetch`, as the transports that accept an override declare it. */
export type FetchFn = (
  url: string | URL,
  init?: FetchInit,
) => Promise<Response>;

/**
 * Flattens headers into a record, masking every credential-bearing value.
 *
 * `Headers` lower-cases the names, which is also what the redaction list is
 * matched against.
 */
function redactFetchHeaders(
  headers?: FetchInit['headers'],
): Record<string, string> {
  const redacted: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    redacted[name] = SENSITIVE_HEADERS.has(name) ? REDACTED : value;
  });
  return redacted;
}

/** Replaces the value of every credential-bearing header in a plain record. */
function redactHeaderRecord(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value,
    ]),
  );
}

/**
 * Maximum records one buffer keeps. A long tool call can perform an unbounded
 * number of exchanges, and the buffer ends up persisted on an event.
 */
export const MAX_HTTP_DEBUG_RECORDS = 100;

/** One captured HTTP request/response pair. Field names match adk-python. */
export interface HttpDebugRecord {
  url: string;
  status_code: number;
  method: string;
  request_headers: Record<string, string>;
  request_body?: string;
  response_headers: Record<string, string>;
  response_body?: string;
}

const httpDebugStorage = new AsyncLocalStorage<HttpDebugRecord[]>();

/**
 * Runs `fn` with `records` installed as the active capture buffer.
 *
 * The caller owns the array, so it can read whatever was captured even when
 * `fn` rejects.
 *
 * @param records The buffer producers append to for the duration of `fn`.
 * @param fn The operation to run under the capture.
 * @return Whatever `fn` resolves to.
 */
export function captureHttpDebug<T>(
  records: HttpDebugRecord[],
  fn: () => Promise<T>,
): Promise<T> {
  return httpDebugStorage.run(records, fn);
}

/** Whether a capture buffer is active, so a producer can skip the work. */
function isHttpDebugCapturing(): boolean {
  return httpDebugStorage.getStore() !== undefined;
}

/**
 * Appends a record to the active capture buffer.
 *
 * Bodies are truncated and the buffer is capped here, so every producer is
 * bounded the same way. A no-op when no capture is active or the buffer is
 * full.
 *
 * @param record The exchange to record. Headers must already be redacted.
 */
export function recordHttpDebug(record: HttpDebugRecord): void {
  const records = httpDebugStorage.getStore();
  if (records === undefined || records.length >= MAX_HTTP_DEBUG_RECORDS) {
    return;
  }
  records.push({
    ...record,
    ...(record.request_body !== undefined && {
      request_body: truncateBody(record.request_body),
    }),
    ...(record.response_body !== undefined && {
      response_body: truncateBody(record.response_body),
    }),
  });
}

/** Builds and appends the record for one completed exchange. */
async function recordExchange(
  url: string | URL,
  init: FetchInit | undefined,
  response: Response,
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? '';
  let responseBody: string;
  if (contentType.toLowerCase().includes(SSE_CONTENT_TYPE)) {
    // Reading an SSE body would starve the transport of its events.
    responseBody = SSE_BODY_PLACEHOLDER;
  } else {
    try {
      responseBody = await response.clone().text();
    } catch (err) {
      responseBody = `<failed to read body: ${formatError(err)}>`;
    }
  }
  recordHttpDebug({
    url: redactUriPassword(url.toString()),
    status_code: response.status,
    method: init?.method ?? 'GET',
    request_headers: redactFetchHeaders(init?.headers),
    ...(typeof init?.body === 'string' && {request_body: init.body}),
    response_headers: redactFetchHeaders(response.headers),
    response_body: responseBody,
  });
}

/**
 * Wraps a `fetch` so every exchange it performs under an active capture is
 * recorded.
 *
 * Recording never fails the request: a failure while building the record is
 * logged at debug level and dropped.
 *
 * @param baseFetch The fetch to delegate to. Defaults to the global `fetch`.
 * @return A drop-in replacement for `baseFetch`.
 */
export function instrumentFetch(baseFetch?: FetchFn): FetchFn {
  const delegate: FetchFn = baseFetch ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    const response = await delegate(url, init);
    if (isHttpDebugCapturing()) {
      try {
        await recordExchange(url, init, response);
      } catch (err) {
        logger.debug('Failed to record HTTP exchange: ' + formatError(err));
      }
    }
    return response;
  };
}

/** Maximum number of exchanges one capture keeps. Further ones are dropped. */
export const MAX_CAPTURED_EXCHANGES = 100;

/** Key under which a capture reaches an invocation's custom metadata. */
const HTTP_DEBUG_INFO_KEY = 'http_debug_info';

/** One HTTP request and its response, as recorded for debugging. */
export interface HttpExchange {
  url: string;
  method: string;
  statusCode: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody: string;
}

const httpExchangeStorage = new AsyncLocalStorage<HttpExchange[]>();

/** Flattens `Headers` into a plain, lower-cased record. */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/** Reads a response body without consuming the response the caller returns. */
async function readResponseBody(response: Response): Promise<string> {
  if ((response.headers.get('content-type') ?? '').includes(SSE_CONTENT_TYPE)) {
    return SSE_BODY_PLACEHOLDER;
  }
  try {
    return await response.clone().text();
  } catch {
    return UNREADABLE_BODY;
  }
}

/**
 * Runs `fn` with `exchanges` installed as the capture buffer for its async
 * context. The caller owns the buffer, so the exchanges recorded before a
 * rejection are still available to it — which is when they matter most.
 *
 * @param exchanges Buffer that receives the recorded exchanges.
 * @param fn The operation to run under the capture.
 * @return Whatever `fn` resolves to.
 */
export function runWithHttpDebugCapture<T>(
  exchanges: HttpExchange[],
  fn: () => Promise<T>,
): Promise<T> {
  return httpExchangeStorage.run(exchanges, fn);
}

/** Whether a capture is installed. A cheap check for a producer to make. */
export function isCapturingHttpDebug(): boolean {
  return httpExchangeStorage.getStore() !== undefined;
}

/**
 * Appends an exchange to the installed capture, redacting its URL and headers
 * and truncating its bodies first. Does nothing when no capture is installed,
 * or when this capture already holds {@link MAX_CAPTURED_EXCHANGES} entries.
 *
 * @param exchange The exchange to record.
 */
export function recordHttpExchange(exchange: HttpExchange): void {
  const exchanges = httpExchangeStorage.getStore();
  if (exchanges === undefined || exchanges.length >= MAX_CAPTURED_EXCHANGES) {
    return;
  }
  exchanges.push({
    ...exchange,
    url: redactUriPassword(exchange.url),
    requestHeaders: redactHeaderRecord(exchange.requestHeaders),
    responseHeaders: redactHeaderRecord(exchange.responseHeaders),
    requestBody:
      exchange.requestBody === undefined
        ? undefined
        : truncateBody(exchange.requestBody),
    responseBody: truncateBody(exchange.responseBody),
  });
}

/** The parts of an outgoing request that a capture records. */
export interface HttpRequestInfo {
  url: string;
  method: string;
  headers: Headers;
  /** Only a textual body is recorded; a binary one is left out. */
  body?: string;
}

/**
 * Describes one completed HTTP exchange as an {@link HttpExchange}.
 *
 * A Server-Sent Events response is recorded by name rather than by content:
 * reading it would consume the stream the caller is about to use. Any other
 * body is read from a clone, leaving the original intact.
 *
 * @param request The request that was sent.
 * @param response The response it received.
 * @return The exchange, before redaction and truncation.
 */
export async function describeHttpExchange(
  request: HttpRequestInfo,
  response: Response,
): Promise<HttpExchange> {
  return {
    url: request.url,
    method: request.method,
    statusCode: response.status,
    requestHeaders: headersToRecord(request.headers),
    responseHeaders: headersToRecord(response.headers),
    requestBody: request.body,
    responseBody: await readResponseBody(response),
  };
}

/**
 * Reads the exchanges recorded against an invocation, newest call last.
 *
 * The key and its shape live here rather than at each call site, so nobody
 * has to cast their way out of the metadata record's `unknown` values.
 *
 * @param customMetadata The invocation's metadata record.
 * @return The recorded exchanges, or an empty array when none were recorded.
 */
export function getHttpDebugInfo(
  customMetadata: Record<string, unknown>,
): HttpExchange[] {
  const recorded = customMetadata[HTTP_DEBUG_INFO_KEY];
  return Array.isArray(recorded) ? (recorded as HttpExchange[]) : [];
}

/**
 * Appends `exchanges` to the invocation's recorded list, creating it on the
 * first write. Later calls in the same invocation extend the list rather than
 * replacing it, and the list is capped so that a long invocation cannot grow
 * it without bound.
 *
 * @param customMetadata The invocation's metadata record, written in place.
 * @param exchanges The exchanges captured during one operation.
 */
export function appendHttpDebugInfo(
  customMetadata: Record<string, unknown>,
  exchanges: HttpExchange[],
): void {
  if (exchanges.length === 0) {
    return;
  }
  customMetadata[HTTP_DEBUG_INFO_KEY] = getHttpDebugInfo(customMetadata)
    .concat(exchanges)
    .slice(0, MAX_CAPTURED_EXCHANGES);
}
