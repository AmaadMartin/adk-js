/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {lookup} from 'node:dns/promises';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import {request as httpsRequest, type RequestOptions} from 'node:https';
import {isIP, type LookupFunction} from 'node:net';

import {z} from 'zod';

import {extractText} from '../utils/html_utils.js';
import {
  isBlockedAddress,
  isBlockedHostname,
  normalizeHost,
} from '../utils/ssrf_utils.js';
import {FunctionTool} from './function_tool.js';

/** Options for {@link loadWebPage}. */
export interface LoadWebPageOptions {
  /** Request timeout in milliseconds. Defaults to 30_000 (30s). */
  timeoutMs?: number;
}

/** URL schemes that are allowed to be fetched (WHATWG `URL.protocol` form). */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Largest response body that is buffered before the request is abandoned. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Python's `requests` decompresses transparently; asking for identity yields
 * the same text without pulling a decompressor into the path.
 */
const IDENTITY_ENCODING = {'accept-encoding': 'identity'};

/** Shortest line kept in the extracted text, in words. */
const MIN_WORDS_PER_LINE = 3;

/** Builds the parity failure message for a URL. */
function failedToFetchMessage(url: string): string {
  return `Failed to fetch url: ${url}`;
}

/**
 * Validates the URL up front (before any network access). Throws for malformed
 * URLs, disallowed schemes and an unconnectable port. An `http`/`https` URL
 * always carries a hostname: the WHATWG parser rejects the scheme without one.
 *
 * The parser also rejects a port that is not a number or is above 65535, so
 * port `0` is the only value left to reject here. Node reads it as "any free
 * port" and dials a port the caller never asked for.
 */
function parseRequestTarget(url: string): URL {
  const parsed = new URL(url);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Unsupported url scheme: ${url}`);
  }
  if (parsed.port === '0') {
    throw new Error(`Invalid url port: ${url}`);
  }
  return parsed;
}

/**
 * The TLS server name for `url`, absent for an IP-literal host: RFC 6066
 * forbids an IP address there, and Node warns and drops it. The certificate is
 * still checked against the host either way.
 */
function serverNameOf(url: URL): string | undefined {
  const hostname = normalizeHost(url.hostname);
  return isIP(hostname) === 0 ? hostname : undefined;
}

/**
 * Resolves `hostname` to a de-duplicated address list. Throws when resolution
 * yields nothing, or when *any* resolved address fails vetting.
 */
async function resolveDirectAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, {all: true});
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve host: ${hostname}`);
  }
  if (addresses.some(isBlockedAddress)) {
    throw new Error(`Blocked host: ${hostname}`);
  }
  return addresses;
}

/**
 * Builds a DNS lookup that always answers with `address`, so the connection
 * reaches the vetted IP while the URL, `Host` header and TLS hostname stay as
 * the caller wrote them.
 */
function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (hostname, options, callback) => {
    if (options.all) {
      callback(null, [{address, family}]);
      return;
    }
    callback(null, address, family);
  };
}

/** Extracts the charset from a `content-type` header, defaulting to UTF-8. */
function charsetOf(contentType: string | undefined): string {
  const match = /charset=\s*"?([^";]+)"?/i.exec(contentType ?? '');
  return match ? match[1].trim() : 'utf-8';
}

/** Decodes a response body, falling back to UTF-8 for an unknown charset. */
function decodeBody(body: Buffer, contentType: string | undefined): string {
  const charset = charsetOf(contentType);
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

/** Buffers a response body, abandoning the request past {@link MAX_RESPONSE_BYTES}. */
function readResponse(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        res.destroy();
        reject(new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      resolve(decodeBody(Buffer.concat(chunks), res.headers['content-type']));
    });
    res.on('error', reject);
  });
}

/**
 * Runs `work` under the call's deadline, destroying `request` when it passes.
 * `expiresAt` is an absolute time, so every attempt a call makes shares one
 * budget instead of restarting the clock.
 */
async function withDeadline<T>(
  request: ClientRequest,
  expiresAt: number,
  work: () => Promise<T>,
): Promise<T> {
  const timer = setTimeout(
    () => request.destroy(new Error('Request timed out')),
    expiresAt - Date.now(),
  );
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}

/** Sends `request` and returns its body, or `null` when the status is not 200. */
function sendRequest(
  request: ClientRequest,
  expiresAt: number,
): Promise<string | null> {
  return withDeadline(request, expiresAt, async () => {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', reject);
      request.end();
    });
    if (res.statusCode !== 200) {
      res.destroy();
      return null;
    }
    return readResponse(res);
  });
}

/**
 * Requests `url` over a connection pinned to `address`. `agent: false`
 * keeps every attempt on its own connection, matching the per-attempt session
 * the Python tool opens.
 */
function requestPinnedAddress(
  url: URL,
  address: string,
  expiresAt: number,
): Promise<string | null> {
  const options: RequestOptions = {
    agent: false,
    headers: {...IDENTITY_ENCODING},
    lookup: pinnedLookup(address),
  };
  if (url.protocol === 'https:') {
    options.servername = serverNameOf(url);
    return sendRequest(httpsRequest(url, options), expiresAt);
  }
  return sendRequest(httpRequest(url, options), expiresAt);
}

/**
 * Tries every vetted address in order. A received response wins whatever its
 * status; only a transport error moves on to the next address.
 */
async function requestPinned(
  url: URL,
  addresses: string[],
  expiresAt: number,
): Promise<string | null> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await requestPinnedAddress(url, address, expiresAt);
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Extracts readable text from an HTML document and keeps only the lines with
 * more than {@link MIN_WORDS_PER_LINE} words, which drops navigation labels and
 * other short fragments (parity with the Python tool).
 */
function htmlToText(html: string): string {
  return extractText(html)
    .split('\n')
    .filter(
      (line) => line.split(/\s+/).filter(Boolean).length > MIN_WORDS_PER_LINE,
    )
    .join('\n');
}

/**
 * Vets `url` and returns its body, or `null` when the status is not 200.
 * Mirrors the Python `_fetch_response` decision tree: an IP literal is vetted
 * in place, and a hostname is resolved and vetted before any connection is
 * made.
 */
async function fetchBody(url: URL, expiresAt: number): Promise<string | null> {
  const hostname = normalizeHost(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked host: ${hostname}`);
  }
  const literal = isIP(hostname) === 0 ? null : hostname;
  if (literal !== null && isBlockedAddress(literal)) {
    throw new Error(`Blocked host: ${hostname}`);
  }
  const addresses =
    literal === null ? await resolveDirectAddresses(hostname) : [literal];
  return requestPinned(url, addresses, expiresAt);
}

/**
 * Fetches the content at `url` and returns its extracted, readable text.
 *
 * Hardened against SSRF: only `http`/`https` URLs are fetched, the host is
 * rejected up front if it is `localhost`-style or resolves to a private /
 * loopback / link-local / shared / reserved / multicast address, and redirects
 * are never followed. The connection is pinned to the address that passed
 * vetting, so a name cannot be re-resolved to a different address after the
 * check. The body is read up to 10 MiB; a larger response fails.
 *
 * Never throws for expected failures (bad scheme, blocked host, non-200,
 * timeout, network error); returns `Failed to fetch url: <url>` instead.
 *
 * No proxy environment variable is read. A proxy resolves the hostname itself,
 * so the tool could not vet the address it reaches, and a machine-wide setting
 * must not switch vetting off for every caller on the host.
 */
export async function loadWebPage(
  url: string,
  options?: LoadWebPageOptions,
): Promise<string> {
  const expiresAt = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const body = await fetchBody(parseRequestTarget(url), expiresAt);
    return body === null ? failedToFetchMessage(url) : htmlToText(body);
  } catch {
    return failedToFetchMessage(url);
  }
}

/** A global {@link FunctionTool} exposing {@link loadWebPage} to the model. */
export const LOAD_WEB_PAGE = new FunctionTool({
  name: 'load_web_page',
  description:
    'Fetches the content at the given URL and returns the readable text extracted from the page.',
  parameters: z.object({
    url: z.string().describe('The URL to fetch and extract text from.'),
  }),
  execute: ({url}) => loadWebPage(url),
});
