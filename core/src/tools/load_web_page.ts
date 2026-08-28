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
import {isIP, type LookupFunction, type Socket} from 'node:net';
import {connect as tlsConnect} from 'node:tls';

import {z} from 'zod';

import {
  isBlockedAddress,
  isBlockedHostname,
  isIpv4InCidr,
  normalizeHost,
} from '../utils/ssrf_utils.js';
import {FunctionTool} from './function_tool.js';

/** Options for {@link loadWebPage}. */
export interface LoadWebPageOptions {
  /** Request timeout in milliseconds. Defaults to 30_000 (30s). */
  timeoutMs?: number;
}

/** A vetted request destination. The URL is never rewritten to the pinned IP. */
interface RequestTarget {
  /** The requested URL, exactly as parsed. */
  readonly url: URL;
  /** The URL hostname with IPv6 brackets stripped (`[::1]` → `::1`). */
  readonly hostname: string;
}

/** URL schemes that are allowed to be fetched (WHATWG `URL.protocol` form). */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Largest response body that is buffered before the request is abandoned. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Port used when the URL omits one. */
const DEFAULT_PORT_BY_SCHEME: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

/**
 * Python's `requests` decompresses transparently; asking for identity yields
 * the same text without pulling a decompressor into the path.
 */
const IDENTITY_ENCODING = {'accept-encoding': 'identity'};

/** Message carried by the error that a deadline raises. */
const TIMEOUT_MESSAGE = 'Request timed out';

/** HTML entities that survive tag stripping, decoded by name. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  copy: '©',
  gt: '>',
  hellip: '…',
  laquo: '«',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  reg: '®',
  trade: '™',
};

/** Builds the parity failure message for a URL. */
function failedToFetchMessage(url: string): string {
  return `Failed to fetch url: ${url}`;
}

/**
 * Validates the URL's scheme up front (before any network access). Throws for
 * malformed URLs and disallowed schemes. An `http`/`https` URL always carries a
 * hostname: the WHATWG parser rejects the scheme without one.
 */
function parseRequestTarget(url: string): RequestTarget {
  const parsed = new URL(url);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Unsupported url scheme: ${url}`);
  }
  return {url: parsed, hostname: normalizeHost(parsed.hostname)};
}

/** Returns the port a URL addresses, filling in the scheme default. */
function portOf(url: URL): number {
  return url.port ? Number(url.port) : DEFAULT_PORT_BY_SCHEME[url.protocol];
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

/** Reads an environment variable, preferring the lowercase spelling. */
function proxyEnv(name: string): string | undefined {
  return process.env[name] || process.env[name.toUpperCase()] || undefined;
}

/** Returns `true` when a `no_proxy` entry covers the target host. */
function matchesNoProxyEntry(hostname: string, entry: string): boolean {
  if (entry.includes('/')) {
    return isIpv4InCidr(hostname, entry);
  }
  const suffix = entry.replace(/^\./, '').toLowerCase();
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/**
 * Returns `true` when `no_proxy` exempts the target. An empty value exempts
 * nothing; `*` exempts everything.
 */
function bypassesProxy(target: RequestTarget): boolean {
  const noProxy = proxyEnv('no_proxy');
  if (!noProxy) {
    return false;
  }
  if (noProxy.trim() === '*') {
    return true;
  }
  const hostname = target.hostname.toLowerCase();
  return noProxy
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => matchesNoProxyEntry(hostname, entry));
}

/**
 * Returns the proxy that the environment configures for `target`, or `null`.
 * Mirrors `requests.utils.get_environ_proxies` and `select_proxy`. Throws for a
 * proxy scheme this tool cannot speak.
 */
function selectProxy(target: RequestTarget): URL | null {
  if (bypassesProxy(target)) {
    return null;
  }
  const scheme = target.url.protocol.slice(0, -1);
  const configured = proxyEnv(`${scheme}_proxy`) ?? proxyEnv('all_proxy');
  if (!configured) {
    return null;
  }
  const proxy = new URL(configured);
  if (!ALLOWED_SCHEMES.has(proxy.protocol)) {
    throw new Error(`Unsupported proxy scheme: ${configured}`);
  }
  return proxy;
}

/** Builds the `Proxy-Authorization` header when the proxy URL carries credentials. */
function proxyAuthHeaders(proxy: URL): Record<string, string> {
  if (!proxy.username) {
    return {};
  }
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return {
    'proxy-authorization': `Basic ${Buffer.from(credentials).toString('base64')}`,
  };
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

/** Runs `work` under a deadline that destroys `request` when it expires. */
async function withDeadline<T>(
  request: ClientRequest,
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const timer = setTimeout(() => {
    request.destroy(new Error(TIMEOUT_MESSAGE));
  }, timeoutMs);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}

/** Sends `request` and returns its body, or `null` when the status is not 200. */
function sendRequest(
  request: ClientRequest,
  timeoutMs: number,
): Promise<string | null> {
  return withDeadline(request, timeoutMs, async () => {
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
 * The TLS server name for `target`, absent for an IP-literal host: RFC 6066
 * forbids an IP address there, and Node warns and drops it. The certificate is
 * still checked against the host either way.
 */
function serverNameOf(target: RequestTarget): string | undefined {
  return isIP(target.hostname) === 0 ? target.hostname : undefined;
}

/**
 * Requests `target` over a connection pinned to `address`. `agent: false`
 * keeps every attempt on its own connection, matching the per-attempt session
 * the Python tool opens.
 */
function requestPinnedAddress(
  target: RequestTarget,
  address: string,
  timeoutMs: number,
): Promise<string | null> {
  const options: RequestOptions = {
    agent: false,
    headers: {...IDENTITY_ENCODING},
    lookup: pinnedLookup(address),
  };
  if (target.url.protocol === 'https:') {
    options.servername = serverNameOf(target);
    return sendRequest(httpsRequest(target.url, options), timeoutMs);
  }
  return sendRequest(httpRequest(target.url, options), timeoutMs);
}

/**
 * Tries every vetted address in order. A received response wins whatever its
 * status; only a transport error moves on to the next address.
 */
async function requestPinned(
  target: RequestTarget,
  addresses: string[],
  timeoutMs: number,
): Promise<string | null> {
  let lastError: unknown = new Error(`Unable to fetch url: ${target.url.href}`);
  for (const address of addresses) {
    try {
      return await requestPinnedAddress(target, address, timeoutMs);
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Opens a TLS tunnel to `target` through `proxy` with an HTTP `CONNECT`. */
function connectProxyTunnel(
  target: RequestTarget,
  proxy: URL,
  timeoutMs: number,
): Promise<Socket> {
  const request = httpRequest({
    headers: proxyAuthHeaders(proxy),
    host: normalizeHost(proxy.hostname),
    method: 'CONNECT',
    path: `${target.url.hostname}:${portOf(target.url)}`,
    port: portOf(proxy),
  });
  return withDeadline(
    request,
    timeoutMs,
    () =>
      new Promise<Socket>((resolve, reject) => {
        request.once('connect', (res: IncomingMessage, socket: Socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            reject(new Error(`Proxy refused CONNECT: ${res.statusCode}`));
            return;
          }
          resolve(tlsConnect({servername: serverNameOf(target), socket}));
        });
        request.once('error', reject);
        request.end();
      }),
  );
}

/**
 * Runs the request for `target` over an established tunnel.
 *
 * No `agent` option is passed, because Node consults `createConnection` only
 * for a request that has no agent, and `agent: false` builds a fresh agent
 * rather than skipping it. A request that lands on any other socket has
 * connected directly, and this path vets no address, so it fails instead.
 */
async function requestThroughTunnel(
  target: RequestTarget,
  socket: Socket,
  timeoutMs: number,
): Promise<string | null> {
  const request = httpsRequest(target.url, {
    createConnection: () => socket,
    headers: {...IDENTITY_ENCODING},
    servername: serverNameOf(target),
  });
  request.once('socket', (used: Socket) => {
    if (used !== socket) {
      request.destroy(new Error('Proxy tunnel was bypassed'));
    }
  });
  try {
    return await sendRequest(request, timeoutMs);
  } finally {
    socket.destroy();
  }
}

/**
 * Requests `target` through `proxy`. The proxy resolves the hostname itself, so
 * this path issues no local DNS query.
 */
async function requestViaProxy(
  target: RequestTarget,
  proxy: URL,
  timeoutMs: number,
): Promise<string | null> {
  if (target.url.protocol === 'http:') {
    const request = httpRequest({
      agent: false,
      headers: {
        ...IDENTITY_ENCODING,
        ...proxyAuthHeaders(proxy),
        host: target.url.host,
      },
      host: normalizeHost(proxy.hostname),
      // Absolute-form request target, as an HTTP proxy expects.
      path: target.url.href,
      port: portOf(proxy),
    });
    return sendRequest(request, timeoutMs);
  }
  // The tunnel and the request it carries share one deadline.
  const expiresAt = Date.now() + timeoutMs;
  const socket = await connectProxyTunnel(target, proxy, timeoutMs);
  return requestThroughTunnel(target, socket, expiresAt - Date.now());
}

/**
 * Vets `target` and returns its body, or `null` when the status is not 200.
 * Mirrors the Python `_fetch_response` decision tree: a proxy short-circuits
 * local resolution, an IP literal is vetted in place, and a hostname is
 * resolved and vetted before any connection is made.
 */
async function fetchBody(
  target: RequestTarget,
  timeoutMs: number,
): Promise<string | null> {
  if (isBlockedHostname(target.hostname)) {
    throw new Error(`Blocked host: ${target.hostname}`);
  }
  const literal = isIP(target.hostname) === 0 ? null : target.hostname;
  if (literal !== null && isBlockedAddress(literal)) {
    throw new Error(`Blocked host: ${target.hostname}`);
  }
  const proxy = selectProxy(target);
  if (proxy !== null) {
    return requestViaProxy(target, proxy, timeoutMs);
  }
  const addresses =
    literal === null
      ? await resolveDirectAddresses(target.hostname)
      : [literal];
  return requestPinned(target, addresses, timeoutMs);
}

/** Decodes HTML entities: the named set above plus decimal and hex forms. */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match: string, entity: string) => {
      if (!entity.startsWith('#')) {
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
      }
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    },
  );
}

/**
 * Extracts readable text from an HTML document. Removes `<script>`/`<style>`
 * blocks and comments, strips remaining tags, decodes entities, and keeps only
 * lines with more than three words (parity with the Python tool).
 */
function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decodeHtmlEntities(withoutCode.replace(/<[^>]+>/g, '\n'));
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.split(/\s+/).filter(Boolean).length > 3)
    .join('\n');
}

/**
 * Fetches the content at `url` and returns its extracted, readable text.
 *
 * Hardened against SSRF: only `http`/`https` URLs are fetched, the host is
 * rejected up front if it is `localhost`-style or resolves to a private /
 * loopback / link-local / shared / reserved / multicast address, and redirects
 * are never followed. Never throws for expected failures (bad scheme, blocked
 * host, non-200, timeout, network error); returns `Failed to fetch url: <url>`
 * instead.
 *
 * The connection is pinned to the address that passed vetting, so a name cannot
 * be re-resolved to a different address after the check. When an environment
 * proxy applies, the proxy resolves the name remotely and only an IP-literal
 * host can be vetted locally — the same caveat the Python tool carries.
 */
export async function loadWebPage(
  url: string,
  options?: LoadWebPageOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const body = await fetchBody(parseRequestTarget(url), timeoutMs);
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
