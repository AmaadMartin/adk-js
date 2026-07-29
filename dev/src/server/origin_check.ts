/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import express, {NextFunction, Request, Response} from 'express';
import * as http from 'node:http';
import * as net from 'node:net';

/** Methods that cannot change server state and are therefore not origin-checked. */
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Every spelling of the loopback interface a browser may put in `Host`. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** Immutable policy computed once per server, from the bound host and port. */
export interface OriginPolicy {
  /** Literal origins from `--allow_origins` ('*' allows any origin). */
  allowedOrigins: string[];
  /**
   * Lower-cased `host[:port]` authorities accepted in the `Host` header, or
   * undefined when the `Host` allowlist does not apply.
   */
  allowedHosts?: Set<string>;
}

/** Inputs to {@link buildOriginPolicy}. */
interface OriginPolicyOptions {
  allowedOrigins: string[];
  /** Address the server is bound to (`server.address().address`). */
  serverHost: string;
  /** Bind host as configured, which the bound address may spell differently. */
  configuredHost: string;
  /** Port the server is bound to. */
  port: number;
}

/** Splits a comma-separated `--allow_origins` value into literal origins. */
export function parseAllowedOrigins(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Returns true if `host` is a loopback address, as Node reports a bound one:
 * a bare address, canonicalized (`::1`, never `0:0:0:0:0:0:0:1`) and port-less.
 */
export function isLoopbackAddress(host: string): boolean {
  // The `isIPv4` guard matters: `127.evil.com` is a hostname, not a loopback IP.
  return (
    LOOPBACK_HOSTS.includes(host) ||
    (net.isIPv4(host) && host.startsWith('127.'))
  );
}

/** Returns the lower-cased `host[:port]` of a URL, or undefined if unparseable. */
function parseUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Validates an `Origin` header against the allowlist, then against same-origin. */
function isRequestOriginAllowed(
  origin: string,
  headers: http.IncomingHttpHeaders,
  policy: OriginPolicy,
): boolean {
  if (
    policy.allowedOrigins.includes('*') ||
    policy.allowedOrigins.includes(origin)
  ) {
    return true;
  }
  // Same origin: the browser addressed the authority it was served from.
  // Forwarding headers are deliberately ignored -- an untrusted
  // `X-Forwarded-Host` would let a caller forge this side of the comparison --
  // and the dev server never terminates TLS, so the scheme is always http.
  return headers.host !== undefined && origin === `http://${headers.host}`;
}

/**
 * Validates the `Host` header against the static allowlist derived from the
 * bind address. This is the DNS-rebinding defence: a page on evil.com that
 * re-resolves to 127.0.0.1 reaches the server with `Host: evil.com:8000` and,
 * being same-origin as far as the browser knows, no `Origin` header at all.
 */
function isRequestHostAllowed(
  headers: http.IncomingHttpHeaders,
  policy: OriginPolicy,
): boolean {
  if (!policy.allowedHosts) {
    return true;
  }
  // Fail closed: every HTTP/1.1 client sends a Host header.
  return (
    headers.host !== undefined &&
    policy.allowedHosts.has(headers.host.toLowerCase())
  );
}

/** Builds the per-server policy from the bound address and the CLI options. */
export function buildOriginPolicy(options: OriginPolicyOptions): OriginPolicy {
  const {allowedOrigins, serverHost, configuredHost, port} = options;
  // A static Host allowlist is only derivable for a loopback bind: a wildcard
  // (0.0.0.0) or public bind is legitimately reachable under any number of LAN
  // addresses, and the DNS-rebinding threat model is the loopback dev server
  // specifically.
  if (!isLoopbackAddress(serverHost)) {
    return {allowedOrigins};
  }

  const allowedHosts = new Set<string>();
  for (const hostname of [serverHost, configuredHost, ...LOOPBACK_HOSTS]) {
    const authority = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
    allowedHosts.add(`${authority}:${port}`.toLowerCase());
  }
  // Keep tunnelled or proxied setups declared via --allow_origins working.
  for (const origin of allowedOrigins) {
    const host = parseUrlHost(origin);
    if (host !== undefined) {
      allowedHosts.add(host);
    }
  }

  return {allowedOrigins, allowedHosts};
}

/** Returns why the request must be rejected, or undefined to let it through. */
export function requestRejectionReason(
  req: {method: string; headers: http.IncomingHttpHeaders},
  policy: OriginPolicy,
): string | undefined {
  if (!isRequestHostAllowed(req.headers, policy)) {
    return 'Forbidden: host not allowed';
  }
  const origin = req.headers.origin;
  // Requests without an Origin (curl, the ADK CLI) are covered by the Host
  // allowlist, not by the origin check.
  if (
    !SAFE_HTTP_METHODS.has(req.method) &&
    origin !== undefined &&
    !isRequestOriginAllowed(origin, req.headers, policy)
  ) {
    return 'Forbidden: origin not allowed';
  }
  return undefined;
}

/**
 * Express middleware rejecting cross-origin state-changing requests and
 * requests whose `Host` header is outside the allowlist.
 *
 * The policy is read through a getter because it depends on the address the
 * server actually bound to, which is unknown while routes are registered.
 */
export function createOriginCheckMiddleware(
  getPolicy: () => OriginPolicy,
  logger: Logger,
): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const reason = requestRejectionReason(req, getPolicy());
    if (reason === undefined) {
      return next();
    }
    logger.warn(
      `${reason}: ${req.method} ${req.originalUrl} (host: ${req.headers.host}, origin: ${req.headers.origin})`,
    );
    res.status(403).type('text/plain').send(reason);
  };
}
