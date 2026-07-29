/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';
import {describe, expect, it} from 'vitest';

import {
  buildOriginPolicy,
  isLoopbackAddress,
  isRequestHostAllowed,
  isRequestOriginAllowed,
  OriginPolicy,
  parseAllowedOrigins,
  requestRejectionReason,
} from '../../src/server/origin_check.js';

const PORT = 8000;

/** Policy of a server bound to loopback, as `buildOriginPolicy` derives it. */
function loopbackPolicy(allowedOrigins: string[] = []): OriginPolicy {
  return buildOriginPolicy({
    allowedOrigins,
    serverHost: '127.0.0.1',
    configuredHost: 'localhost',
    port: PORT,
  });
}

function headers(host?: string, origin?: string): http.IncomingHttpHeaders {
  return {host, origin};
}

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1', '127.1.2.3'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackAddress(host)).toBe(true);
    },
  );

  it.each([
    'evil.com',
    '127.evil.com',
    '0.0.0.0',
    '192.168.1.1',
    '10.0.0.1',
    '128.0.0.1',
    '2001:db8::1',
    '',
  ])('treats %s as non-loopback', (host) => {
    expect(isLoopbackAddress(host)).toBe(false);
  });
});

describe('parseAllowedOrigins', () => {
  it.each([
    [undefined, []],
    ['', []],
    ['*', ['*']],
    ['http://a, http://b', ['http://a', 'http://b']],
    ['http://a,', ['http://a']],
  ])('parses %s', (value, expected) => {
    expect(parseAllowedOrigins(value)).toEqual(expected);
  });
});

describe('buildOriginPolicy', () => {
  it('accepts every loopback spelling of a loopback bind', () => {
    const policy = loopbackPolicy();

    expect(policy.allowedHosts).toEqual(
      new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]),
    );
  });

  it('accepts the configured host name alongside the bound address', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '127.0.0.1',
      configuredHost: 'dev.localtest',
      port: PORT,
    });

    expect(policy.allowedHosts?.has(`dev.localtest:${PORT}`)).toBe(true);
  });

  it('does not enforce the host check on a wildcard bind', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '0.0.0.0',
      configuredHost: '0.0.0.0',
      port: PORT,
    });

    expect(policy.allowedHosts).toBeUndefined();
  });

  it('brackets an IPv6 bind address, as browsers do', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '::1',
      configuredHost: '::1',
      port: PORT,
    });

    expect(policy.allowedHosts?.has(`[::1]:${PORT}`)).toBe(true);
  });

  it('accepts the hosts of configured origins but not the wildcard', () => {
    const policy = loopbackPolicy(['https://tunnel.example', '*']);

    expect(policy.allowedHosts?.has('tunnel.example')).toBe(true);
    expect(policy.allowedHosts?.has('*')).toBe(false);
  });
});

describe('isRequestOriginAllowed', () => {
  it('allows an explicitly configured origin', () => {
    const allowed = isRequestOriginAllowed(
      'http://localhost:4200',
      headers(`localhost:${PORT}`),
      loopbackPolicy(['http://localhost:4200']),
    );

    expect(allowed).toBe(true);
  });

  it('allows any origin when the wildcard is configured', () => {
    const allowed = isRequestOriginAllowed(
      'http://evil.com',
      headers(`localhost:${PORT}`),
      loopbackPolicy(['*']),
    );

    expect(allowed).toBe(true);
  });

  it('blocks a request whose own origin cannot be determined', () => {
    const allowed = isRequestOriginAllowed(
      `http://localhost:${PORT}`,
      headers(undefined),
      loopbackPolicy(),
    );

    expect(allowed).toBe(false);
  });
});

describe('isRequestHostAllowed', () => {
  const policy = loopbackPolicy();

  it.each([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `LOCALHOST:${PORT}`])(
    'accepts the allowlisted host %s',
    (host) => {
      expect(isRequestHostAllowed(headers(host), policy)).toBe(true);
    },
  );

  it('rejects a missing host while enforcing', () => {
    expect(isRequestHostAllowed(headers(undefined), policy)).toBe(false);
  });

  it('accepts a missing host when not enforcing', () => {
    const wildcardBind = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '0.0.0.0',
      configuredHost: '0.0.0.0',
      port: PORT,
    });

    expect(isRequestHostAllowed(headers(undefined), wildcardBind)).toBe(true);
  });
});

describe('requestRejectionReason', () => {
  // The DNS-rebinding scenarios ported from the Python dev server: a page that
  // re-resolves its own name to the loopback address reaches the server with an
  // attacker-controlled Host, with or without a matching Origin.
  it.each([
    ['evil.com:8000', 'http://evil.com'],
    ['127.evil.com:8000', 'http://127.evil.com'],
    ['evil.com:8000', undefined],
  ])('blocks a rebound request with host %s', (host, origin) => {
    const reason = requestRejectionReason(
      {method: 'POST', headers: headers(host, origin)},
      loopbackPolicy(),
    );

    expect(reason).toBe('Forbidden: host not allowed');
  });

  it('blocks a safe method from a rebound host', () => {
    const reason = requestRejectionReason(
      {method: 'GET', headers: headers('evil.com:8000')},
      loopbackPolicy(),
    );

    expect(reason).toBe('Forbidden: host not allowed');
  });

  it('blocks a cross-origin state-changing request', () => {
    const reason = requestRejectionReason(
      {
        method: 'POST',
        headers: headers(`localhost:${PORT}`, 'http://evil.com'),
      },
      loopbackPolicy(),
    );

    expect(reason).toBe('Forbidden: origin not allowed');
  });

  it('allows a cross-origin safe request', () => {
    const reason = requestRejectionReason(
      {method: 'GET', headers: headers(`localhost:${PORT}`, 'http://evil.com')},
      loopbackPolicy(),
    );

    expect(reason).toBeUndefined();
  });

  it('allows a state-changing request without an origin', () => {
    const reason = requestRejectionReason(
      {method: 'POST', headers: headers(`localhost:${PORT}`)},
      loopbackPolicy(),
    );

    expect(reason).toBeUndefined();
  });

  it('allows a same-origin state-changing request', () => {
    const reason = requestRejectionReason(
      {
        method: 'POST',
        headers: headers(`localhost:${PORT}`, `http://localhost:${PORT}`),
      },
      loopbackPolicy(),
    );

    expect(reason).toBeUndefined();
  });
});
