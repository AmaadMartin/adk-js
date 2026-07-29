/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import {Request, Response} from 'express';
import * as http from 'node:http';
import * as net from 'node:net';
import {PassThrough} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';

import {
  buildOriginPolicy,
  createOriginCheckMiddleware,
  createUpgradeGuard,
  firstHeaderValue,
  getRequestOrigin,
  isLoopbackAddress,
  isOriginAllowed,
  isRequestHostAllowed,
  isRequestOriginAllowed,
  normalizeOriginScheme,
  OriginPolicy,
  parseAllowedOrigins,
  RequestInfo,
} from '../../src/server/origin_check.js';

const PORT = 8000;

function makeLogger(): Logger {
  return {
    log: vi.fn(),
    setLogLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeRequest({
  host = '127.0.0.1:8000',
  method = 'POST',
  headers = {},
  encrypted = false,
}: {
  host?: string;
  method?: string;
  headers?: http.IncomingHttpHeaders;
  encrypted?: boolean;
} = {}): RequestInfo {
  return {method, headers: {host, ...headers}, encrypted};
}

function makePolicy(overrides: Partial<OriginPolicy> = {}): OriginPolicy {
  return {
    allowedOrigins: [],
    hasConfiguredAllowedOrigins: false,
    serverHost: '127.0.0.1',
    allowedHosts: new Set<string>(),
    enforceHostCheck: false,
    trustProxyHeaders: false,
    ...overrides,
  };
}

describe('isLoopbackAddress', () => {
  it.each([
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '127.0.0.1:8000',
    'localhost:8000',
    '[::1]:8000',
    '127.1.2.3',
  ])('treats %s as loopback', (host) => {
    expect(isLoopbackAddress(host)).toBe(true);
  });

  it.each([
    'evil.com',
    '127.evil.com',
    '0.0.0.0',
    '192.168.1.1',
    '10.0.0.1',
    '128.0.0.1',
    '2001:db8::1',
    '[2001:db8::1]:8000',
    '[unterminated',
    '',
  ])('treats %s as non-loopback', (host) => {
    expect(isLoopbackAddress(host)).toBe(false);
  });
});

describe('isRequestOriginAllowed', () => {
  it.each([
    ['127.0.0.1', 'evil.com:8000', 'http://evil.com'],
    ['127.0.0.1', '127.evil.com:8000', 'http://127.evil.com'],
    ['localhost', 'evil.com', 'http://evil.com'],
    ['::1', 'evil.com', 'http://evil.com'],
  ])(
    'blocks DNS rebinding onto server %s with host %s',
    (serverHost, host, origin) => {
      const allowed = isRequestOriginAllowed(
        origin,
        makeRequest({host}),
        makePolicy({serverHost}),
      );

      expect(allowed).toBe(false);
    },
  );

  it('blocks an unparseable origin on a loopback server', () => {
    const allowed = isRequestOriginAllowed(
      'not-a-url',
      makeRequest(),
      makePolicy(),
    );

    expect(allowed).toBe(false);
  });

  it.each([
    ['127.0.0.1', '127.0.0.1:8000', 'http://127.0.0.1:8000'],
    ['127.0.0.1', 'localhost:8000', 'http://localhost:8000'],
  ])('allows same-origin %s / %s', (serverHost, host, origin) => {
    const allowed = isRequestOriginAllowed(
      origin,
      makeRequest({host}),
      makePolicy({serverHost}),
    );

    expect(allowed).toBe(true);
  });

  it('lets an explicit allowlist override the DNS-rebinding guard', () => {
    const allowed = isRequestOriginAllowed(
      'http://evil.com',
      makeRequest({host: 'evil.com'}),
      makePolicy({
        allowedOrigins: ['http://evil.com'],
        hasConfiguredAllowedOrigins: true,
      }),
    );

    expect(allowed).toBe(true);
  });

  it('applies no DNS guard on a non-loopback server', () => {
    const allowed = isRequestOriginAllowed(
      'http://example.com:8000',
      makeRequest({host: 'example.com:8000'}),
      makePolicy({serverHost: '0.0.0.0'}),
    );

    expect(allowed).toBe(true);
  });

  it('blocks a cross-origin request outside the configured allowlist', () => {
    const allowed = isRequestOriginAllowed(
      'http://evil.com',
      makeRequest({host: 'example.com:8000'}),
      makePolicy({
        serverHost: '0.0.0.0',
        allowedOrigins: ['http://good.example'],
        hasConfiguredAllowedOrigins: true,
      }),
    );

    expect(allowed).toBe(false);
  });

  it('blocks a request whose origin cannot be computed', () => {
    const allowed = isRequestOriginAllowed(
      'http://localhost:8000',
      makeRequest({headers: {host: undefined}}),
      makePolicy(),
    );

    expect(allowed).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('allows any origin when the wildcard is configured', () => {
    expect(isOriginAllowed('http://evil.com', ['*'])).toBe(true);
  });

  it('allows a literal match', () => {
    expect(isOriginAllowed('http://a.example', ['http://a.example'])).toBe(
      true,
    );
  });

  it('rejects an origin outside the list', () => {
    expect(isOriginAllowed('http://b.example', ['http://a.example'])).toBe(
      false,
    );
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

describe('normalizeOriginScheme', () => {
  it.each([
    ['ws', 'http'],
    ['wss', 'https'],
    ['https', 'https'],
  ])('maps %s to %s', (scheme, expected) => {
    expect(normalizeOriginScheme(scheme)).toBe(expected);
  });
});

describe('firstHeaderValue', () => {
  it('returns the first comma-separated value, trimmed', () => {
    expect(
      firstHeaderValue({forwarded: 'a.example , b.example'}, 'forwarded'),
    ).toBe('a.example');
  });

  it('returns the first entry of a duplicated header', () => {
    expect(
      firstHeaderValue(
        {'x-forwarded-host': ['a.example', 'b.example']},
        'x-forwarded-host',
      ),
    ).toBe('a.example');
  });

  it('returns undefined for a missing header', () => {
    expect(firstHeaderValue({}, 'origin')).toBeUndefined();
  });
});

describe('getRequestOrigin', () => {
  it('derives the origin from the Host header', () => {
    expect(getRequestOrigin(makeRequest(), false)).toBe(
      'http://127.0.0.1:8000',
    );
  });

  it('uses https for a TLS connection', () => {
    expect(getRequestOrigin(makeRequest({encrypted: true}), false)).toBe(
      'https://127.0.0.1:8000',
    );
  });

  it('honours the Forwarded header when proxy headers are trusted', () => {
    const req = makeRequest({
      headers: {forwarded: 'proto=https;host="a.example"'},
    });

    expect(getRequestOrigin(req, true)).toBe('https://a.example');
  });

  it('ignores the Forwarded header by default', () => {
    const req = makeRequest({
      headers: {forwarded: 'proto=https;host="a.example"'},
    });

    expect(getRequestOrigin(req, false)).toBe('http://127.0.0.1:8000');
  });

  it('skips Forwarded elements that are not name=value pairs', () => {
    const req = makeRequest({
      headers: {forwarded: 'proto=https;host="a.example";garbage'},
    });

    expect(getRequestOrigin(req, true)).toBe('https://a.example');
  });

  it('falls back to Host when Forwarded has no host', () => {
    const req = makeRequest({headers: {forwarded: 'proto=https;by=proxy'}});

    expect(getRequestOrigin(req, true)).toBe('http://127.0.0.1:8000');
  });

  it('honours X-Forwarded-Host and X-Forwarded-Proto when trusted', () => {
    const req = makeRequest({
      headers: {'x-forwarded-host': 'a.example', 'x-forwarded-proto': 'https'},
    });

    expect(getRequestOrigin(req, true)).toBe('https://a.example');
  });

  it('ignores X-Forwarded-Host and X-Forwarded-Proto by default', () => {
    const req = makeRequest({
      headers: {'x-forwarded-host': 'a.example', 'x-forwarded-proto': 'https'},
    });

    expect(getRequestOrigin(req, false)).toBe('http://127.0.0.1:8000');
  });

  it('returns undefined without a Host header', () => {
    const req = makeRequest({headers: {host: undefined}});

    expect(getRequestOrigin(req, false)).toBeUndefined();
  });
});

describe('buildOriginPolicy', () => {
  it('accepts every loopback spelling of a loopback bind', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '127.0.0.1',
      configuredHost: 'localhost',
      port: PORT,
      trustProxyHeaders: false,
    });

    expect(policy.enforceHostCheck).toBe(true);
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
      trustProxyHeaders: false,
    });

    expect(policy.allowedHosts.has(`dev.localtest:${PORT}`)).toBe(true);
  });

  it('does not enforce the host check on a wildcard bind', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '0.0.0.0',
      configuredHost: '0.0.0.0',
      port: PORT,
      trustProxyHeaders: false,
    });

    expect(policy.enforceHostCheck).toBe(false);
    expect(policy.allowedHosts).toEqual(new Set([`0.0.0.0:${PORT}`]));
  });

  it('brackets an IPv6 bind address', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '2001:db8::1',
      configuredHost: '2001:db8::1',
      port: PORT,
      trustProxyHeaders: false,
    });

    expect(policy.allowedHosts).toEqual(new Set([`[2001:db8::1]:${PORT}`]));
  });

  it('does not enforce the host check when proxy headers are trusted', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '127.0.0.1',
      configuredHost: 'localhost',
      port: PORT,
      trustProxyHeaders: true,
    });

    expect(policy.enforceHostCheck).toBe(false);
  });

  it('accepts the hosts of configured origins', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: ['https://tunnel.example', '*'],
      serverHost: '127.0.0.1',
      configuredHost: 'localhost',
      port: PORT,
      trustProxyHeaders: false,
    });

    expect(policy.hasConfiguredAllowedOrigins).toBe(true);
    expect(policy.allowedHosts.has('tunnel.example')).toBe(true);
    expect(policy.allowedHosts.has('*')).toBe(false);
  });

  it('accepts port-less authorities on the default HTTP port', () => {
    const policy = buildOriginPolicy({
      allowedOrigins: [],
      serverHost: '127.0.0.1',
      configuredHost: 'localhost',
      port: 80,
      trustProxyHeaders: false,
    });

    expect(policy.allowedHosts.has('localhost')).toBe(true);
    expect(policy.allowedHosts.has('localhost:80')).toBe(true);
  });
});

describe('isRequestHostAllowed', () => {
  const policy = makePolicy({
    enforceHostCheck: true,
    allowedHosts: new Set([`localhost:${PORT}`]),
  });

  it('accepts an allowlisted host regardless of case', () => {
    expect(
      isRequestHostAllowed(makeRequest({host: 'LOCALHOST:8000'}), policy),
    ).toBe(true);
  });

  it('rejects a host outside the allowlist', () => {
    expect(
      isRequestHostAllowed(makeRequest({host: 'evil.com:8000'}), policy),
    ).toBe(false);
  });

  it('rejects a missing host while enforcing', () => {
    expect(
      isRequestHostAllowed(makeRequest({headers: {host: undefined}}), policy),
    ).toBe(false);
  });

  it('accepts a missing host when not enforcing', () => {
    expect(
      isRequestHostAllowed(
        makeRequest({headers: {host: undefined}}),
        makePolicy(),
      ),
    ).toBe(true);
  });

  it('ignores X-Forwarded-Host, which never overrides the real Host', () => {
    const req = makeRequest({
      host: 'evil.com:8000',
      headers: {'x-forwarded-host': `localhost:${PORT}`},
    });

    expect(isRequestHostAllowed(req, policy)).toBe(false);
  });
});

interface MiddlewareResult {
  status?: number;
  body?: string;
  nextCalled: boolean;
}

function runMiddleware(
  policy: OriginPolicy | undefined,
  req: RequestInfo,
  logger: Logger = makeLogger(),
): MiddlewareResult {
  const result: MiddlewareResult = {nextCalled: false};
  const res = {
    status(code: number) {
      result.status = code;
      return this;
    },
    type() {
      return this;
    },
    send(body: string) {
      result.body = body;
    },
  };

  createOriginCheckMiddleware(() => policy, logger)(
    {
      method: req.method,
      headers: req.headers,
      secure: req.encrypted,
      originalUrl: '/run',
    } as unknown as Request,
    res as unknown as Response,
    () => {
      result.nextCalled = true;
    },
  );

  return result;
}

describe('createOriginCheckMiddleware', () => {
  const policy = makePolicy({
    enforceHostCheck: true,
    allowedHosts: new Set([`localhost:${PORT}`]),
  });

  it('fails open before the policy is known', () => {
    expect(runMiddleware(undefined, makeRequest()).nextCalled).toBe(true);
  });

  it('rejects a host outside the allowlist', () => {
    const logger = makeLogger();

    const result = runMiddleware(
      policy,
      makeRequest({host: 'evil.com:8000', method: 'GET'}),
      logger,
    );

    expect(result.status).toBe(403);
    expect(result.body).toBe('Forbidden: host not allowed');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('evil.com:8000'),
    );
  });

  it('rejects a cross-origin state-changing request', () => {
    const result = runMiddleware(
      policy,
      makeRequest({
        host: `localhost:${PORT}`,
        headers: {origin: 'http://evil.com'},
      }),
    );

    expect(result.status).toBe(403);
    expect(result.body).toBe('Forbidden: origin not allowed');
  });

  it('allows a cross-origin safe request', () => {
    const result = runMiddleware(
      policy,
      makeRequest({
        host: `localhost:${PORT}`,
        method: 'GET',
        headers: {origin: 'http://evil.com'},
      }),
    );

    expect(result.nextCalled).toBe(true);
  });

  it('allows a state-changing request without an origin', () => {
    const result = runMiddleware(
      policy,
      makeRequest({host: `localhost:${PORT}`}),
    );

    expect(result.nextCalled).toBe(true);
  });
});

function emitUpgrade(
  server: http.Server,
  headers: http.IncomingHttpHeaders,
  method?: string,
) {
  const req = new http.IncomingMessage(new net.Socket());
  req.headers = headers;
  req.method = method;
  const socket = new PassThrough();
  const write = vi.spyOn(socket, 'write');
  const destroy = vi.spyOn(socket, 'destroy');

  server.emit('upgrade', req, socket, Buffer.alloc(0));

  return {write, destroy};
}

describe('createUpgradeGuard', () => {
  const policy = makePolicy({
    enforceHostCheck: true,
    allowedHosts: new Set([`localhost:${PORT}`]),
  });

  it('rejects an upgrade whose origin is not allowed', () => {
    const server = new http.Server();
    const logger = makeLogger();
    createUpgradeGuard(server, () => policy, logger);

    const {write, destroy} = emitUpgrade(
      server,
      {host: `localhost:${PORT}`, origin: 'http://evil.com'},
      'GET',
    );

    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('HTTP/1.1 403 Forbidden'),
    );
    expect(destroy).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Forbidden: origin not allowed'),
    );
  });

  it('closes an allowed upgrade that nothing else handles', () => {
    const server = new http.Server();
    createUpgradeGuard(server, () => policy, makeLogger());

    const {write, destroy} = emitUpgrade(server, {host: `localhost:${PORT}`});

    expect(write).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });

  it('leaves an allowed upgrade to a downstream handler', () => {
    const server = new http.Server();
    createUpgradeGuard(server, () => policy, makeLogger());
    server.on('upgrade', () => {});

    const {destroy} = emitUpgrade(server, {host: `localhost:${PORT}`});

    expect(destroy).not.toHaveBeenCalled();
  });

  it('fails open before the policy is known', () => {
    const server = new http.Server();
    createUpgradeGuard(server, () => undefined, makeLogger());

    const {write, destroy} = emitUpgrade(server, {host: 'evil.com:8000'});

    expect(write).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});
