/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import express, {NextFunction, Request, Response} from 'express';
import * as http from 'node:http';
import * as net from 'node:net';
import {Duplex} from 'node:stream';
import {TLSSocket} from 'node:tls';

/** Methods that cannot change server state and are therefore not origin-checked. */
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Hostnames that always denote the loopback interface. */
const LOOPBACK_HOSTNAMES = new Set(['localhost']);

/** Every spelling of the loopback interface a browser may put in `Host`. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** Allow-origins entry that disables the origin allowlist entirely. */
export const WILDCARD_ORIGIN = '*';

/** Port browsers omit from the `Host` header. */
const DEFAULT_HTTP_PORT = 80;

const FORBIDDEN_ORIGIN_MESSAGE = 'Forbidden: origin not allowed';
const FORBIDDEN_HOST_MESSAGE = 'Forbidden: host not allowed';

/** Minimal view of an inbound request, shared by the HTTP and WS upgrade paths. */
export interface RequestInfo {
  /** 'GET', 'POST', ... (always 'GET' for a WebSocket upgrade). */
  method: string;
  headers: http.IncomingHttpHeaders;
  /** Whether the connection is TLS-terminated by this server. */
  encrypted: boolean;
}

/** Immutable policy computed once per server, from the bound host and port. */
export interface OriginPolicy {
  /** Literal origins from `--allow_origins` ('*' kept verbatim). */
  allowedOrigins: string[];
  /** True when `--allow_origins` was non-empty. */
  hasConfiguredAllowedOrigins: boolean;
  /** Address the server is actually bound to. */
  serverHost: string;
  /** Lower-cased `host[:port]` authorities accepted in the `Host` header. */
  allowedHosts: Set<string>;
  /** Whether the `Host` allowlist is enforced at all. */
  enforceHostCheck: boolean;
  /** Whether `X-Forwarded-*` / `Forwarded` headers are honoured. */
  trustProxyHeaders: boolean;
}

/** Inputs to {@link buildOriginPolicy}. */
export interface OriginPolicyOptions {
  /** Literal origins parsed from `--allow_origins`. */
  allowedOrigins: string[];
  /** Address the server is bound to (`server.address().address`). */
  serverHost: string;
  /** Bind host as configured, which may be a name the bound address does not spell. */
  configuredHost: string;
  /** Port the server is bound to. */
  port: number;
  trustProxyHeaders: boolean;
}

/** Splits a comma-separated `--allow_origins` value into literal origins. */
export function parseAllowedOrigins(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** Normalizes a request scheme to the browser `Origin` scheme space. */
export function normalizeOriginScheme(scheme: string): string {
  if (scheme === 'ws') {
    return 'http';
  }
  if (scheme === 'wss') {
    return 'https';
  }
  return scheme;
}

/** Returns the first comma-separated value of a header, trimmed. */
export function firstHeaderValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',', 1)[0].trim();
}

/**
 * Returns true if `host` (with or without a port) refers to a loopback address.
 *
 * Accepts every form browsers and Node produce: `127.0.0.1`, `127.0.0.1:8000`,
 * any other `127.x.x.x`, `localhost[:port]`, `::1`, `[::1]` and `[::1]:8000`.
 */
export function isLoopbackAddress(host: string): boolean {
  const bare = stripPort(host);
  if (LOOPBACK_HOSTNAMES.has(bare)) {
    return true;
  }
  // The `isIPv4` guard matters: `127.evil.com` is a hostname, not a loopback IP.
  if (net.isIPv4(bare)) {
    return bare.startsWith('127.');
  }
  // The URL parser canonicalizes every IPv6 spelling (`0:0:0:0:0:0:0:1`,
  // `::0001`, ...) to its compressed form, so one comparison covers them all.
  return net.isIPv6(bare) && parseUrlHost(`http://[${bare}]`) === '[::1]';
}

/** Strips an optional `:port` suffix, handling bracketed IPv6 literals. */
function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(1, end);
  }
  // An IPv6 literal without brackets has more than one colon and no port.
  return host.split(':').length === 2
    ? host.slice(0, host.lastIndexOf(':'))
    : host;
}

/** Returns the lower-cased `host[:port]` of a URL, or undefined if unparseable. */
function parseUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Strips a single pair of wrapping quotes from a header value. */
function stripOptionalQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** Returns the origin from a `Forwarded` header that carries both proto and host. */
function forwardedOrigin(
  headers: http.IncomingHttpHeaders,
): string | undefined {
  const forwarded = firstHeaderValue(headers, 'forwarded');
  if (forwarded === undefined) {
    return undefined;
  }

  const parameters = new Map<string, string>();
  for (const element of forwarded.split(';')) {
    const separator = element.indexOf('=');
    if (separator === -1) {
      continue;
    }
    parameters.set(
      element.slice(0, separator).trim().toLowerCase(),
      stripOptionalQuotes(element.slice(separator + 1).trim()),
    );
  }

  const proto = parameters.get('proto');
  const host = parameters.get('host');
  return proto !== undefined && host !== undefined
    ? `${normalizeOriginScheme(proto)}://${host}`
    : undefined;
}

/**
 * Computes the effective origin of the server as seen by this request.
 *
 * Forwarding headers are only consulted when `trustProxyHeaders` is set: an
 * untrusted `X-Forwarded-Host` would let a caller forge the server side of the
 * same-origin comparison.
 */
export function getRequestOrigin(
  req: RequestInfo,
  trustProxyHeaders: boolean,
): string | undefined {
  if (trustProxyHeaders) {
    const forwarded = forwardedOrigin(req.headers);
    if (forwarded !== undefined) {
      return forwarded;
    }
  }

  const host =
    (trustProxyHeaders
      ? firstHeaderValue(req.headers, 'x-forwarded-host')
      : undefined) ?? firstHeaderValue(req.headers, 'host');
  if (host === undefined) {
    return undefined;
  }

  const scheme =
    (trustProxyHeaders
      ? firstHeaderValue(req.headers, 'x-forwarded-proto')
      : undefined) ?? (req.encrypted ? 'https' : 'http');
  return `${normalizeOriginScheme(scheme)}://${host}`;
}

/** Returns true if `origin` matches the configured allowlist. */
export function isOriginAllowed(
  origin: string,
  allowedOrigins: string[],
): boolean {
  return (
    allowedOrigins.includes(WILDCARD_ORIGIN) || allowedOrigins.includes(origin)
  );
}

/**
 * Validates an `Origin` header against explicit config or same-origin.
 *
 * DNS-rebinding protection: when the server is bound to loopback and no
 * explicit allow-origins are configured, the origin must itself be loopback.
 * Otherwise a page on evil.com that temporarily resolves to 127.0.0.1 could
 * satisfy the same-origin comparison using the `Host` header it controls.
 */
export function isRequestOriginAllowed(
  origin: string,
  req: RequestInfo,
  policy: OriginPolicy,
): boolean {
  if (
    policy.hasConfiguredAllowedOrigins &&
    isOriginAllowed(origin, policy.allowedOrigins)
  ) {
    return true;
  }

  if (
    !policy.hasConfiguredAllowedOrigins &&
    isLoopbackAddress(policy.serverHost)
  ) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (!isLoopbackAddress(originHost)) {
      return false;
    }
  }

  return origin === getRequestOrigin(req, policy.trustProxyHeaders);
}

/**
 * Validates the `Host` header against the static allowlist derived from the
 * bind address, which is what stops a DNS-rebound page that sends no `Origin`.
 *
 * `X-Forwarded-Host` is never consulted: trusting a proxy turns the check off
 * altogether (see {@link buildOriginPolicy}), so the real `Host` is the only
 * value that can be judged here.
 */
export function isRequestHostAllowed(
  req: RequestInfo,
  policy: OriginPolicy,
): boolean {
  if (!policy.enforceHostCheck) {
    return true;
  }
  const host = firstHeaderValue(req.headers, 'host');
  // Fail closed: every HTTP/1.1 client sends a Host header.
  return host !== undefined && policy.allowedHosts.has(host.toLowerCase());
}

/** Builds the per-server policy from the bound address and the CLI options. */
export function buildOriginPolicy(options: OriginPolicyOptions): OriginPolicy {
  const {allowedOrigins, serverHost, configuredHost, port, trustProxyHeaders} =
    options;
  const hostnames = new Set([serverHost, configuredHost]);
  if (isLoopbackAddress(serverHost)) {
    for (const hostname of LOOPBACK_HOSTS) {
      hostnames.add(hostname);
    }
  }

  const allowedHosts = new Set<string>();
  for (const hostname of hostnames) {
    const authority = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
    allowedHosts.add(`${authority}:${port}`.toLowerCase());
    if (port === DEFAULT_HTTP_PORT) {
      allowedHosts.add(authority.toLowerCase());
    }
  }
  // Keep tunnelled/proxied setups declared via --allow_origins working.
  for (const origin of allowedOrigins) {
    const host = parseUrlHost(origin);
    if (host !== undefined) {
      allowedHosts.add(host);
    }
  }

  return {
    allowedOrigins,
    hasConfiguredAllowedOrigins: allowedOrigins.length > 0,
    serverHost,
    allowedHosts,
    // A static Host allowlist is only derivable for a loopback bind: a wildcard
    // (0.0.0.0) or public bind is legitimately reachable under any number of
    // LAN addresses, and --trust_proxy_headers declares that a proxy owns Host.
    enforceHostCheck: isLoopbackAddress(serverHost) && !trustProxyHeaders,
    trustProxyHeaders,
  };
}

/**
 * Returns the reason the request must be rejected, or undefined to let it
 * through. `checkOrigin` is forced on for WebSocket upgrades, whose method is
 * always GET yet whose handshake is state-changing.
 */
export function requestRejectionReason(
  req: RequestInfo,
  policy: OriginPolicy,
  checkOrigin = !SAFE_HTTP_METHODS.has(req.method),
): string | undefined {
  if (!isRequestHostAllowed(req, policy)) {
    return FORBIDDEN_HOST_MESSAGE;
  }
  const origin = firstHeaderValue(req.headers, 'origin');
  // Requests without an Origin (curl, the ADK CLI) are covered by the Host
  // allowlist, not by the origin check.
  if (
    checkOrigin &&
    origin !== undefined &&
    !isRequestOriginAllowed(origin, req, policy)
  ) {
    return FORBIDDEN_ORIGIN_MESSAGE;
  }
  return undefined;
}

function formatRequest(req: RequestInfo, path?: string): string {
  return `${req.method} ${path} (host: ${req.headers.host}, origin: ${req.headers.origin})`;
}

/**
 * Express middleware rejecting cross-origin state-changing requests and
 * requests whose `Host` header is outside the allowlist.
 *
 * The policy is read through a getter because it is only known once the server
 * is listening; until then the gate fails open so startup traffic is not 403ed.
 */
export function createOriginCheckMiddleware(
  getPolicy: () => OriginPolicy | undefined,
  logger: Logger,
): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const policy = getPolicy();
    if (!policy) {
      return next();
    }
    const info: RequestInfo = {
      method: req.method,
      headers: req.headers,
      encrypted: req.secure,
    };
    const reason = requestRejectionReason(info, policy);
    if (reason === undefined) {
      return next();
    }
    logger.warn(`${reason}: ${formatRequest(info, req.originalUrl)}`);
    res.status(403).type('text/plain').send(reason);
  };
}

/** Applies the same gate to WebSocket upgrades, before any upgrade handler. */
export function createUpgradeGuard(
  server: http.Server,
  getPolicy: () => OriginPolicy | undefined,
  logger: Logger,
): void {
  server.prependListener(
    'upgrade',
    (req: http.IncomingMessage, socket: Duplex) => {
      const policy = getPolicy();
      if (!policy) {
        return;
      }
      const info: RequestInfo = {
        method: req.method ?? 'GET',
        headers: req.headers,
        encrypted: socket instanceof TLSSocket,
      };
      const reason = requestRejectionReason(info, policy, true);
      if (reason !== undefined) {
        logger.warn(`${reason}: ${formatRequest(info, req.url)}`);
        socket.write(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        socket.destroy();
        return;
      }
      // Node only closes an upgrade socket when the server has no 'upgrade'
      // listener. Now that this guard is one, preserve that default when it is
      // the only listener, otherwise the socket leaks and server.close() hangs.
      if (server.listenerCount('upgrade') === 1) {
        socket.destroy();
      }
    },
  );
}
