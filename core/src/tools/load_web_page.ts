/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LookupAddress} from 'node:dns';
import {lookup} from 'node:dns/promises';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import {request as httpsRequest, type RequestOptions} from 'node:https';
import {isIP, type Socket} from 'node:net';
import {connect as tlsConnect} from 'node:tls';

import {z} from 'zod';

import {htmlToText} from '../utils/html_utils.js';
import {environmentProxyFor, proxyAuthHeaders} from '../utils/proxy_utils.js';
import {isBlockedAddress, isBlockedHostname} from '../utils/ssrf_utils.js';
import {FunctionTool} from './function_tool.js';

/** Options for {@link loadWebPage}. */
export interface LoadWebPageOptions {
  /** Request timeout in milliseconds, per attempt. Defaults to 30_000 (30s). */
  timeoutMs?: number;
}

/** URL schemes that are allowed to be fetched (WHATWG `URL.protocol` form). */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Largest response body read before the attempt is abandoned. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** A vetted fetch target: where to connect, and what to claim to be. */
interface RequestTarget {
  /** The parsed, canonicalized URL. */
  url: URL;
  /** The host without brackets, e.g. `::1` or `example.com`. */
  hostname: string;
  /** The `Host` header value, e.g. `[64:ff9b::808:808]` or `example.com:8443`. */
  hostHeader: string;
  /** The explicit port, or the scheme's default. */
  port: number;
  /** Whether the connection has to be TLS. */
  isTls: boolean;
}

/** A completed HTTP response, body already read and decoded. */
interface FetchedResponse {
  status: number;
  body: string;
}

/** Builds the parity failure message for a URL. */
function failedToFetchMessage(url: string): string {
  return `Failed to fetch url: ${url}`;
}

/** Strips the surrounding brackets from an IPv6 URL host (`[::1]` -> `::1`). */
function stripBrackets(host: string): string {
  return host.startsWith('[') ? host.slice(1, -1) : host;
}

/** Returns a URL's explicit port, or the default for its scheme. */
function portOf(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * Parses and validates `url`, or throws describing why it cannot be fetched.
 * `new URL` already rejects a port outside 0-65535, so there is no separate
 * port check.
 */
function parseRequestTarget(url: string): RequestTarget {
  const parsed = new URL(url);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Unsupported url scheme: ${url}`);
  }
  return {
    url: parsed,
    hostname: stripBrackets(parsed.hostname),
    // WHATWG already brackets an IPv6 host and elides the default port.
    hostHeader: parsed.host,
    port: portOf(parsed),
    isTls: parsed.protocol === 'https:',
  };
}

/**
 * Resolves `hostname` to a de-duplicated address list, and refuses the whole
 * hostname when any answer is not globally routable.
 */
async function resolveDirectAddresses(hostname: string): Promise<string[]> {
  let records: LookupAddress[];
  try {
    records = await lookup(hostname, {all: true});
  } catch {
    throw new Error(`Unable to resolve host: ${hostname}`);
  }
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
 * The TLS server name for a target, or `undefined` for an IP-literal host:
 * RFC 6066 forbids an IP literal as a server name, and Node warns (DEP0123)
 * when one is passed.
 */
function serverNameOf(target: RequestTarget): string | undefined {
  return isIP(target.hostname) === 0 ? target.hostname : undefined;
}

/** The origin-form request URI: path and query, never the fragment. */
function requestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/** The absolute-form request URI a proxy expects, without the fragment. */
function absoluteRequestUri(url: URL): string {
  const withoutFragment = new URL(url.href);
  withoutFragment.hash = '';
  return withoutFragment.href;
}

/** Builds the TextDecoder for a `Content-Type`, defaulting to UTF-8. */
function decoderFor(contentType: string | undefined): TextDecoder {
  const charset = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '');
  try {
    return new TextDecoder(charset?.[1].trim());
  } catch {
    // A label the runtime does not know must not fail the fetch.
    return new TextDecoder();
  }
}

/**
 * Reads `response` into `resolve`, or hands a transport failure to `fail`.
 * The body is bounded by {@link MAX_RESPONSE_BYTES}.
 */
function readResponse(
  response: IncomingMessage,
  resolve: (value: FetchedResponse) => void,
  fail: (error: Error) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  // A server that drops the socket after the headers destroys the response
  // with an error. Node only emits that error when something listens for it,
  // and it never reaches the request, so without this the read never ends.
  response.on('error', fail);
  response.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      fail(new Error('Response body is too large'));
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => {
    resolve({
      status: response.statusCode ?? 0,
      body: decoderFor(response.headers['content-type']).decode(
        Buffer.concat(chunks),
      ),
    });
  });
}

/**
 * Sends `request` and reads its response. Every failure both destroys the
 * request, which releases its socket, its timer and its listeners, and settles
 * the promise, so no exit path can leave the caller waiting.
 */
function sendRequest(
  request: ClientRequest,
  timeoutMs: number,
): Promise<FetchedResponse> {
  return new Promise<FetchedResponse>((resolve, reject) => {
    const fail = (error: Error) => {
      request.destroy(error);
      reject(error);
    };
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => fail(new Error('Request timed out')));
    request.on('response', (response) => readResponse(response, resolve, fail));
    request.end();
  });
}

/**
 * Requests `target` over a connection pinned to `address`, an address that has
 * already been vetted. `hostname` is the literal IP, so the socket layer never
 * resolves a name and the answer that was checked is the one connected to.
 *
 * Node's core HTTP clients ignore the `*_proxy` environment variables, which
 * is exactly Python's `proxies={'http': None, 'https': None}`. Do not swap in
 * a proxy-reading agent here: it would defeat the pinning.
 */
function requestPinned(
  target: RequestTarget,
  address: string,
  timeoutMs: number,
): Promise<FetchedResponse> {
  const servername = serverNameOf(target);
  const options: RequestOptions = {
    hostname: address,
    port: target.port,
    path: requestPath(target.url),
    method: 'GET',
    // Node must not synthesize a Host header from the pinned IP, and the
    // certificate is validated against the original hostname, not the IP.
    setHost: false,
    headers: {Host: target.hostHeader},
    agent: false,
    ...(servername === undefined ? {} : {servername}),
  };
  return sendRequest(
    target.isTls ? httpsRequest(options) : httpRequest(options),
    timeoutMs,
  );
}

/**
 * Tries every vetted address in order and returns the first response. A
 * non-200 response is a result, not a reason to try the next address.
 */
async function fetchDirect(
  target: RequestTarget,
  addresses: string[],
  timeoutMs: number,
): Promise<FetchedResponse> {
  // Never thrown while `addresses` is non-empty, which every caller guarantees.
  let lastError: unknown = new Error(`Unable to fetch url: ${target.url.href}`);
  for (const address of addresses) {
    try {
      return await requestPinned(target, address, timeoutMs);
    } catch (err: unknown) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Requests an `http:` target through `proxy`, in absolute-form. */
function requestThroughProxy(
  target: RequestTarget,
  proxy: URL,
  timeoutMs: number,
): Promise<FetchedResponse> {
  const request = httpRequest({
    hostname: stripBrackets(proxy.hostname),
    port: portOf(proxy),
    path: absoluteRequestUri(target.url),
    method: 'GET',
    setHost: false,
    headers: {Host: target.hostHeader, ...proxyAuthHeaders(proxy)},
    agent: false,
  });
  return sendRequest(request, timeoutMs);
}

/** Opens a tunnel to `target` through `proxy` with an HTTP `CONNECT`. */
function connectTunnel(
  target: RequestTarget,
  proxy: URL,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const request = httpRequest({
      hostname: stripBrackets(proxy.hostname),
      port: portOf(proxy),
      method: 'CONNECT',
      // CONNECT names an authority, which always carries an explicit port.
      path: `${target.url.hostname}:${target.port}`,
      headers: proxyAuthHeaders(proxy),
      agent: false,
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error('Proxy connection timed out')),
    );
    // Node reports every answer to a CONNECT through `connect`, including a
    // refusal, and detaches the socket before doing so.
    request.on('connect', (response, socket: Socket) => {
      if (response.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      reject(new Error(`Proxy refused CONNECT: ${response.statusCode}`));
    });
    request.end();
  });
}

/** Requests an `https:` target through a tunnel that `proxy` opens. */
async function requestThroughTunnel(
  target: RequestTarget,
  proxy: URL,
  timeoutMs: number,
): Promise<FetchedResponse> {
  const socket = await connectTunnel(target, proxy, timeoutMs);
  try {
    // `host` is what the certificate is checked against when there is no
    // server name, so an IP-literal target is verified against the IP rather
    // than against the proxy's own hostname.
    const secure = tlsConnect({
      socket,
      host: target.hostname,
      servername: serverNameOf(target),
    });
    const request = httpsRequest({
      createConnection: () => secure,
      port: target.port,
      path: requestPath(target.url),
      method: 'GET',
      setHost: false,
      headers: {Host: target.hostHeader},
    });
    return await sendRequest(request, timeoutMs);
  } catch (err: unknown) {
    socket.destroy();
    throw err;
  }
}

/**
 * Routes `url` to a response. A proxy short-circuits every local lookup,
 * because the proxy resolves the name itself; otherwise the address is vetted
 * and the connection is pinned to it.
 */
async function fetchResponse(
  url: string,
  timeoutMs: number,
): Promise<FetchedResponse> {
  const target = parseRequestTarget(url);
  if (isBlockedHostname(target.hostname)) {
    throw new Error(`Blocked host: ${target.hostname}`);
  }
  const literal = isIP(target.hostname) === 0 ? undefined : target.hostname;
  if (literal !== undefined && isBlockedAddress(literal)) {
    throw new Error(`Blocked host: ${target.hostname}`);
  }
  const proxy = environmentProxyFor(target.url.protocol, target.hostname);
  if (proxy !== undefined) {
    return target.isTls
      ? requestThroughTunnel(target, proxy, timeoutMs)
      : requestThroughProxy(target, proxy, timeoutMs);
  }
  const addresses =
    literal === undefined
      ? await resolveDirectAddresses(target.hostname)
      : [literal];
  return fetchDirect(target, addresses, timeoutMs);
}

/** Keeps only the lines that carry more than three whitespace-separated words. */
function keepLongLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.split(/\s+/).filter(Boolean).length > 3)
    .join('\n');
}

/**
 * Fetches the content at `url` and returns its extracted, readable text.
 *
 * Hardened against server-side request forgery. Only `http`/`https` URLs are
 * fetched, redirects are never followed, and the host is refused when it is
 * `localhost`-style or resolves to an address that is not globally routable —
 * including an IPv6 address that wraps such an IPv4 address, as NAT64, 6to4
 * and IPv4-compatible addresses do. The connection is then pinned to the exact
 * address that was vetted, so no second name resolution can substitute another
 * one, while the original `Host` header and TLS server name are preserved.
 *
 * Two limits are worth knowing. A proxy named by `http_proxy`, `https_proxy`
 * or `all_proxy` resolves the hostname itself, so on that path only an
 * IP-literal target can be vetted locally. A hostname that resolves to a mix
 * of blocked and public addresses is refused outright rather than fetched over
 * the public ones.
 *
 * Never throws for an expected failure (bad scheme, invalid port, blocked
 * host, DNS failure, transport error, timeout, oversized body, non-200);
 * returns `Failed to fetch url: <url>` instead.
 */
export async function loadWebPage(
  url: string,
  options?: LoadWebPageOptions,
): Promise<string> {
  try {
    const {status, body} = await fetchResponse(
      url,
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (status !== 200) {
      return failedToFetchMessage(url);
    }
    return keepLongLines(htmlToText(body));
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
