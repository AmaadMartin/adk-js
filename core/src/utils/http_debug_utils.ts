/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An ambient sink for HTTP exchanges captured while debugging.
 *
 * A caller opens a buffer around an operation with {@link captureHttpDebug};
 * any producer running inside that operation appends to it with
 * {@link recordHttpDebug}, without the buffer being threaded through the calls
 * in between. Outside a capture every append is a no-op.
 */

import {AsyncLocalStorage} from 'node:async_hooks';

import {formatError, truncateBody} from './error_utils.js';
import {logger} from './logger.js';
import {redactUriPassword} from './redact_uri.js';

/**
 * Header names whose value is a credential. Compared lower-case. Mirrors
 * adk-python's `_redact_headers`.
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

/**
 * Flattens headers into a record, masking every credential-bearing value.
 *
 * `Headers` lower-cases the names, which is also what the redaction list is
 * matched against.
 */
function redactHeaders(headers?: FetchInit['headers']): Record<string, string> {
  const redacted: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    redacted[name] = SENSITIVE_HEADERS.has(name) ? REDACTED : value;
  });
  return redacted;
}

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

/** Recorded in place of an SSE body, which must not be read. */
const SSE_BODY_PLACEHOLDER = '<SSE stream>';

/** Builds and appends the record for one completed exchange. */
async function recordExchange(
  url: string | URL,
  init: FetchInit | undefined,
  response: Response,
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? '';
  let responseBody: string;
  if (contentType.toLowerCase().includes('text/event-stream')) {
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
    request_headers: redactHeaders(init?.headers),
    ...(typeof init?.body === 'string' && {request_body: init.body}),
    response_headers: redactHeaders(response.headers),
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
