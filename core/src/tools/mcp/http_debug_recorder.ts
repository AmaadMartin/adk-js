/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recording of the HTTP exchanges an MCP call makes, for a debug dump.
 *
 * Internal to the MCP tools: the `@google/adk/tools/mcp` barrel lists its
 * modules explicitly and does not include this one.
 */

import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import {AsyncLocalStorage} from 'node:async_hooks';

import {redactHeaders} from '../../utils/redact_headers.js';

/**
 * One HTTP exchange an MCP session made, as recorded for a debug dump.
 *
 * Headers are redacted and bodies are never captured: a recorded exchange is
 * expected to end up attached to a bug report.
 */
export interface McpHttpExchange {
  url: string;
  method: string;
  status: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}

/**
 * The sink collecting HTTP exchanges for the MCP call running on this async
 * stack, or nothing when no caller asked for a recording.
 *
 * `MCPTool` installs a sink for the duration of one tool call when debug
 * logging is on, then drains it onto the invocation. Mirrors Python's
 * `_http_debug_var` contextvar.
 */
export const mcpHttpDebugStorage = new AsyncLocalStorage<McpHttpExchange[]>();

/**
 * Upper bound on the exchanges one sink keeps. A long-running agent retries,
 * reconnects and polls, so an uncapped sink grows without limit. Past the cap
 * the recorder drops the exchange and the request still proceeds.
 */
export const MAX_HTTP_DEBUG_EXCHANGES = 100;

/** The headers of a request the transport makes, in any shape `fetch` takes. */
type FetchHeaders = NonNullable<Parameters<FetchLike>[1]>['headers'];

/** Reads request or response headers into a plain, redacted object. */
function readHeaders(headers: FetchHeaders): Record<string, string> {
  const plain: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    plain[name] = value;
  });
  return redactHeaders(plain);
}

/**
 * Wraps `baseFetch` so each exchange it completes is recorded into `sink`.
 *
 * The wrapper never changes what the caller sees: it returns the response
 * untouched, whatever the status, and lets a transport failure propagate with
 * nothing recorded for it. Capture must never fail a tool call.
 */
export function createRecordingFetch(
  baseFetch: FetchLike,
  sink: McpHttpExchange[],
): FetchLike {
  return async (url, init) => {
    const startedAt = Date.now();
    const response = await baseFetch(url, init);

    if (sink.length < MAX_HTTP_DEBUG_EXCHANGES) {
      sink.push({
        url: url.toString(),
        method: init?.method ?? 'GET',
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestHeaders: readHeaders(init?.headers),
        responseHeaders: readHeaders(response.headers),
      });
    }

    return response;
  };
}
