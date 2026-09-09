/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncLocalStorage} from 'node:async_hooks';

import {MAX_RESPONSE_BODY_LENGTH, TRUNCATION_MARKER} from './error_utils.js';
import {redactUriPassword} from './redact_uri.js';

/**
 * Capture of the HTTP exchanges behind an operation, for an operator who has
 * to see what actually went over the wire.
 *
 * A capture is installed for the duration of one call and is scoped to that
 * call's async context, so two concurrent captures never see each other's
 * entries. A credential in the URL or the headers is removed as each exchange
 * is recorded, because a capture reaches the invocation's custom metadata,
 * which the rest of the invocation can read.
 *
 * Bodies are truncated but not redacted, matching adk-python. A credential a
 * server puts in a response body is therefore recorded verbatim, so treat a
 * capture as sensitive: it is only produced under debug logging.
 */

/** Maximum number of exchanges one capture keeps. Further ones are dropped. */
export const MAX_CAPTURED_EXCHANGES = 100;

/** Key under which a capture reaches an invocation's custom metadata. */
const HTTP_DEBUG_INFO_KEY = 'http_debug_info';

/** Replaces the value of a header that carries a credential. */
const REDACTED = '<redacted>';

/** Recorded in place of a streaming body, which must not be consumed. */
const SSE_BODY_PLACEHOLDER = '<SSE stream>';

/** Recorded when the response body cannot be read. */
const UNREADABLE_BODY = '<failed to read body>';

/** Content type of a Server-Sent Events response. */
const SSE_CONTENT_TYPE = 'text/event-stream';

/**
 * Header names whose values are redacted, lower-cased. A superset of the four
 * that adk-python redacts, covering the other header names in common use for
 * an API key.
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

const httpDebugStorage = new AsyncLocalStorage<HttpExchange[]>();

/** Truncates a body to {@link MAX_RESPONSE_BODY_LENGTH} characters. */
function truncateBody(body: string): string {
  return body.length > MAX_RESPONSE_BODY_LENGTH
    ? body.slice(0, MAX_RESPONSE_BODY_LENGTH) + TRUNCATION_MARKER
    : body;
}

/** Replaces the value of every credential-bearing header. */
function redactHeaders(
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
 * Flattens `Headers` into a plain, lower-cased record.
 *
 * `Object.fromEntries(headers)` is not available: `tsconfig.json` sets
 * `lib: ["ES2022", "DOM"]` without `DOM.Iterable`, so `Headers` is not
 * iterable here.
 *
 * @param headers The headers to flatten.
 * @return One entry per header, keyed by its lower-cased name.
 */
export function headersToRecord(headers: Headers): Record<string, string> {
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
  return httpDebugStorage.run(exchanges, fn);
}

/** Whether a capture is installed. A cheap check for a producer to make. */
export function isCapturingHttpDebug(): boolean {
  return httpDebugStorage.getStore() !== undefined;
}

/**
 * Appends an exchange to the installed capture, redacting its URL and headers
 * and truncating its bodies first. Does nothing when no capture is installed,
 * or when this capture already holds {@link MAX_CAPTURED_EXCHANGES} entries.
 *
 * @param exchange The exchange to record.
 */
export function recordHttpExchange(exchange: HttpExchange): void {
  const exchanges = httpDebugStorage.getStore();
  if (exchanges === undefined || exchanges.length >= MAX_CAPTURED_EXCHANGES) {
    return;
  }
  exchanges.push({
    ...exchange,
    url: redactUriPassword(exchange.url),
    requestHeaders: redactHeaders(exchange.requestHeaders),
    responseHeaders: redactHeaders(exchange.responseHeaders),
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
