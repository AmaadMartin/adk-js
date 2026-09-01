/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncLocalStorage} from 'node:async_hooks';

import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {redactHeaders} from '../../utils/redact_headers.js';
import {redactUriPassword} from '../../utils/redact_uri.js';

/** Characters of a captured body kept before it is truncated. */
const MAX_BODY_LENGTH = 1000;

/** Marker appended to a body cut at {@link MAX_BODY_LENGTH}. */
const TRUNCATION_MARKER = '... [truncated]';

/**
 * Exchanges one sink keeps. A streaming session makes an unbounded number of
 * HTTP round trips, and the sink is attached to an event, so it cannot grow
 * with the session. Exchanges past the cap are dropped.
 */
const MAX_RECORDED_EXCHANGES = 50;

/** Recorded in place of an event-stream body, which must not be read. */
const SSE_BODY_PLACEHOLDER = '<SSE stream>';

/** The content type whose body is a live stream. */
const SSE_CONTENT_TYPE = 'text/event-stream';

/** The URL argument a {@link FetchLike} receives. */
type FetchUrl = Parameters<FetchLike>[0];

/** The request-init argument a {@link FetchLike} receives. */
type FetchInit = Parameters<FetchLike>[1];

/** One HTTP request and its response, as recorded for debugging. */
export interface HttpDebugExchange {
  /** The request URL, with any credential in it masked. */
  url: string;
  /** Snake_case, because the record leaves the process on an event. */
  status_code: number;
  method: string;
  request_headers: Record<string, string>;
  request_body?: string;
  response_headers: Record<string, string>;
  response_body?: string;
}

const httpDebugStorage = new AsyncLocalStorage<HttpDebugExchange[]>();

/**
 * Runs `callback` with `sink` as the active exchange sink, so a transport
 * created inside it records into `sink`.
 *
 * @param sink The list the recorder appends to.
 * @param callback The work to run.
 * @returns Whatever `callback` returns.
 */
export function runWithHttpDebugSink<T>(
  sink: HttpDebugExchange[],
  callback: () => T,
): T {
  return httpDebugStorage.run(sink, callback);
}

/** The sink of the innermost {@link runWithHttpDebugSink}, if any. */
export function getHttpDebugSink(): HttpDebugExchange[] | undefined {
  return httpDebugStorage.getStore();
}

function truncate(body: string): string {
  return body.length > MAX_BODY_LENGTH
    ? body.slice(0, MAX_BODY_LENGTH) + TRUNCATION_MARKER
    : body;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const collected: Record<string, string> = {};
  headers.forEach((value, name) => {
    collected[name] = value;
  });
  return redactHeaders(collected);
}

/**
 * Reads the response body without disturbing the caller's copy, and never
 * throws: a body that cannot be read is described rather than reported.
 */
async function readBody(response: Response): Promise<string> {
  try {
    return truncate(await response.clone().text());
  } catch (error: unknown) {
    return `<failed to read body: ${formatError(error)}>`;
  }
}

async function toExchange(
  url: FetchUrl,
  init: FetchInit,
  response: Response,
): Promise<HttpDebugExchange> {
  const isSse = (response.headers.get('content-type') ?? '')
    .toLowerCase()
    .includes(SSE_CONTENT_TYPE);

  return {
    url: redactUriPassword(String(url)),
    status_code: response.status,
    method: init?.method ?? 'GET',
    request_headers: headersToRecord(new Headers(init?.headers)),
    request_body:
      typeof init?.body === 'string' ? truncate(init.body) : undefined,
    response_headers: headersToRecord(response.headers),
    // Reading an event-stream body would starve the transport of its events.
    response_body: isSse ? SSE_BODY_PLACEHOLDER : await readBody(response),
  };
}

/**
 * Wraps `baseFetch` so every exchange it makes is appended to `sink`.
 *
 * Recording never changes the outcome of the request: a failure while
 * recording is logged and swallowed, and the response is returned untouched.
 *
 * @param sink The list to append to, capped at 50 exchanges.
 * @param baseFetch The fetch to delegate to; the global `fetch` by default.
 * @returns A fetch that records what it sends and receives.
 */
export function createRecordingFetch(
  sink: HttpDebugExchange[],
  baseFetch: FetchLike = fetch,
): FetchLike {
  return async (url, init) => {
    const response = await baseFetch(url, init);

    if (sink.length < MAX_RECORDED_EXCHANGES) {
      try {
        sink.push(await toExchange(url, init, response));
      } catch (error: unknown) {
        logger.warn(
          'Failed to record an MCP HTTP exchange: ' + formatError(error),
        );
      }
    }

    return response;
  };
}
