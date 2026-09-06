/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LookupAddress} from 'node:dns';
import {EventEmitter} from 'node:events';
import type {RequestOptions} from 'node:https';
import {Readable} from 'node:stream';

import {FunctionTool, LOAD_WEB_PAGE, loadWebPage} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/** The argument shapes `node:http` / `node:https` `request` is called with. */
type RequestArgs = [URL, RequestOptions] | [RequestOptions];

const {httpRequestMock, httpsRequestMock, lookupMock, tlsConnectMock} =
  vi.hoisted(() => ({
    httpRequestMock: vi.fn<(...args: RequestArgs) => FakeRequest>(),
    httpsRequestMock: vi.fn<(...args: RequestArgs) => FakeRequest>(),
    lookupMock:
      vi.fn<
        (hostname: string, options: {all: true}) => Promise<LookupAddress[]>
      >(),
    tlsConnectMock: vi.fn<() => FakeSocket>(),
  }));

vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: httpRequestMock,
}));

vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  request: httpsRequestMock,
}));

vi.mock('node:tls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tls')>()),
  connect: tlsConnectMock,
}));

/** Placeholder proxy credentials, split so no literal `user:pass@host` exists. */
const PROXY_USER = 'agent';
const PROXY_SECRET = 'not-a-real-password';

/** A stand-in for a TCP or TLS socket. */
class FakeSocket extends EventEmitter {
  readonly destroy = vi.fn();
}

/** A stand-in for `http.ClientRequest` that the test drives by hand. */
class FakeRequest extends EventEmitter {
  destroyed = false;

  constructor(
    readonly url: URL | undefined,
    readonly options: RequestOptions,
  ) {
    super();
  }

  end(): void {
    onRequestEnd(this);
  }

  destroy(error?: Error): void {
    this.destroyed = true;
    if (error) {
      this.emit('error', error);
    }
  }
}

/** Every request the tool issued, in order. */
let sentRequests: FakeRequest[] = [];

/** Drives a request once the tool has finished sending it. */
let onRequestEnd: (request: FakeRequest) => void = () => {};

function createFakeRequest(...args: RequestArgs): FakeRequest {
  const request =
    args.length === 2
      ? new FakeRequest(args[0], args[1])
      : new FakeRequest(undefined, args[0]);
  sentRequests.push(request);
  return request;
}

interface ResponseOptions {
  status?: number;
  headers?: Record<string, string>;
}

/** Emits a response on `request`. */
function emitResponse(
  request: FakeRequest,
  body: string | Buffer,
  {status = 200, headers = {}}: ResponseOptions = {},
): void {
  const chunk = typeof body === 'string' ? Buffer.from(body) : body;
  request.emit(
    'response',
    Object.assign(Readable.from([chunk]), {statusCode: status, headers}),
  );
}

/** Answers every request with the same body. */
function respondWith(body: string | Buffer, options?: ResponseOptions): void {
  onRequestEnd = (request) => emitResponse(request, body, options);
}

/** Answers a `CONNECT` request with a tunnel, then the tunnelled request. */
function respondThroughTunnel(body: string, connectStatus = 200): void {
  onRequestEnd = (request) => {
    if (request.options.method === 'CONNECT') {
      request.emit('connect', {statusCode: connectStatus}, new FakeSocket());
      return;
    }
    emitResponse(request, body);
  };
}

/** Resolves any hostname to the given IP list for the DNS `lookup` mock. */
function resolveTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}

/** Asserts that the tool issued no request at all. */
function expectNoRequest(): void {
  expect(sentRequests).toHaveLength(0);
}

/** Returns the addresses the pinned lookup of `request` answers with. */
function pinnedLookupResults(request: FakeRequest): {
  single: string;
  all: LookupAddress[];
} {
  const pinned = request.options.lookup;
  if (pinned === undefined) {
    expect.fail('the request was issued without a pinned lookup');
  }
  let single = '';
  let all: LookupAddress[] = [];
  pinned('ignored.example', {}, (_error, address) => {
    single = Array.isArray(address) ? '' : address;
  });
  pinned('ignored.example', {all: true}, (_error, address) => {
    all = Array.isArray(address) ? address : [];
  });
  return {single, all};
}

describe('loadWebPage', () => {
  beforeEach(() => {
    sentRequests = [];
    onRequestEnd = () => {};
    httpRequestMock.mockImplementation(createFakeRequest);
    httpsRequestMock.mockImplementation(createFakeRequest);
    tlsConnectMock.mockImplementation(() => new FakeSocket());
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('scheme and hostname rejection (no network)', () => {
    it('rejects non-http(s) schemes without resolving or fetching', async () => {
      const result = await loadWebPage('file:///etc/passwd');

      expect(result).toBe('Failed to fetch url: file:///etc/passwd');
      expectNoRequest();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects malformed URLs', async () => {
      const result = await loadWebPage('not a url');

      expect(result).toBe('Failed to fetch url: not a url');
      expectNoRequest();
    });

    it('rejects the localhost hostname', async () => {
      const result = await loadWebPage('http://localhost:8080/');

      expect(result).toBe('Failed to fetch url: http://localhost:8080/');
      expectNoRequest();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects *.localhost hostnames', async () => {
      const result = await loadWebPage('http://api.localhost./');

      expect(result).toBe('Failed to fetch url: http://api.localhost./');
      expectNoRequest();
    });
  });

  describe('SSRF IP rejection', () => {
    it('rejects loopback IPv4 literals without a DNS lookup', async () => {
      const url =
        'http://127.0.0.1:19876/latest/meta-data/iam/security-credentials/';

      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expectNoRequest();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects shared address space (CGNAT) IPv4 literals', async () => {
      const result = await loadWebPage('http://100.64.0.1/internal');

      expect(result).toBe('Failed to fetch url: http://100.64.0.1/internal');
      expectNoRequest();
    });

    it.each([
      'http://10.1.2.3/',
      'http://172.16.5.4/',
      'http://192.168.1.1/',
      'http://169.254.169.254/',
      'http://0.0.0.0/',
      'http://192.0.2.5/',
      'http://198.18.0.1/',
      'http://224.0.0.1/',
      'http://240.0.0.1/',
    ])('rejects non-global IPv4 literal %s', async (url) => {
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expectNoRequest();
    });

    it('rejects a private IP discovered via DNS resolution', async () => {
      resolveTo('169.254.169.254');

      const url = 'http://metadata.google.internal/computeMetadata/v1/';
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(lookupMock).toHaveBeenCalledWith('metadata.google.internal', {
        all: true,
      });
      expectNoRequest();
    });

    it('rejects when any of several resolved addresses is non-global', async () => {
      resolveTo('93.184.216.34', '10.0.0.5');

      const result = await loadWebPage('http://mixed.example/');

      expect(result).toBe('Failed to fetch url: http://mixed.example/');
      expectNoRequest();
    });

    it('fails closed when DNS resolves to an unparseable address', async () => {
      resolveTo('not-an-ip');

      const result = await loadWebPage('http://weird.example/');

      expect(result).toBe('Failed to fetch url: http://weird.example/');
      expectNoRequest();
    });

    it('fails closed when DNS resolves to an out-of-range IPv4', async () => {
      resolveTo('1.2.3.999');

      const result = await loadWebPage('http://weird.example/');

      expect(result).toBe('Failed to fetch url: http://weird.example/');
      expectNoRequest();
    });

    it('fails when DNS resolution returns no addresses', async () => {
      lookupMock.mockResolvedValue([]);

      const result = await loadWebPage('http://empty.example/');

      expect(result).toBe('Failed to fetch url: http://empty.example/');
      expectNoRequest();
    });

    it('fails when DNS resolution throws', async () => {
      lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

      const result = await loadWebPage('http://missing.example/');

      expect(result).toBe('Failed to fetch url: http://missing.example/');
      expectNoRequest();
    });

    it('rejects IPv6 loopback literals', async () => {
      const result = await loadWebPage('http://[::1]/');

      expect(result).toBe('Failed to fetch url: http://[::1]/');
      expectNoRequest();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it.each([
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[ff02::1]/',
      'http://[2001:db8::1]/',
      'http://[::]/',
    ])('rejects non-global IPv6 literal %s', async (url) => {
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expectNoRequest();
    });

    it('rejects an IPv4-mapped IPv6 address pointing at a private IP', async () => {
      resolveTo('::ffff:127.0.0.1');

      const result = await loadWebPage('http://mapped.example/');

      expect(result).toBe('Failed to fetch url: http://mapped.example/');
      expectNoRequest();
    });

    it('rejects a NAT64 address that embeds the metadata IP', async () => {
      const url = 'http://[64:ff9b::169.254.169.254]/computeMetadata/v1/';

      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expectNoRequest();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects an IPv4-compatible address that embeds a private IP', async () => {
      const url = 'http://[::169.254.169.254]/latest/meta-data/';

      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expectNoRequest();
    });

    it.each(['http://[2002:7f00:1::]/', 'http://[2002:5db8:d822::]/'])(
      'rejects the 6to4 literal %s',
      async (url) => {
        const result = await loadWebPage(url);

        expect(result).toBe(`Failed to fetch url: ${url}`);
        expectNoRequest();
      },
    );
  });

  describe('successful fetch and text extraction', () => {
    it('extracts readable text and drops short lines', async () => {
      resolveTo('93.184.216.34');
      respondWith(
        '<html><body><p>This page has enough words to keep.</p>' +
          '<p>tiny</p></body></html>',
      );

      const result = await loadWebPage('https://example.com/search?q=adk');

      expect(result).toBe('This page has enough words to keep.');
      expect(sentRequests).toHaveLength(1);
      expect(String(sentRequests[0].url)).toBe(
        'https://example.com/search?q=adk',
      );
      expect(sentRequests[0].options).toMatchObject({
        servername: 'example.com',
      });
    });

    it('strips <script> and <style> blocks and decodes entities', async () => {
      resolveTo('93.184.216.34');
      respondWith(
        '<html><head><style>.a{color:red}</style>' +
          '<script>var secret = "do not leak this";</script></head>' +
          '<body><!-- a comment that should vanish -->' +
          '<p>Fish &amp; chips are quite tasty today</p></body></html>',
      );

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Fish & chips are quite tasty today');
      expect(result).not.toContain('secret');
      expect(result).not.toContain('color:red');
      expect(result).not.toContain('comment');
    });

    it('allows a global IPv6 literal target', async () => {
      respondWith('<p>The quick brown fox jumped over here</p>');

      const result = await loadWebPage('http://[2606:4700:4700::1111]/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(sentRequests).toHaveLength(1);
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('allows a global IPv6 address resolved via DNS (full form)', async () => {
      resolveTo('2606:4700:4700:0:0:0:0:1111');
      respondWith('<p>The quick brown fox jumped over here</p>');

      const result = await loadWebPage('http://ipv6.example/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(sentRequests).toHaveLength(1);
    });

    it('allows an IPv4-mapped IPv6 address pointing at a public IP', async () => {
      resolveTo('::ffff:93.184.216.34');
      respondWith('<p>The quick brown fox jumped over here</p>');

      const result = await loadWebPage('http://mapped-public.example/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(sentRequests).toHaveLength(1);
    });

    it('returns an empty string when no line has enough words', async () => {
      resolveTo('93.184.216.34');
      respondWith('<p>too short</p>');

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('');
    });

    it('allows a NAT64 address that embeds a public IP', async () => {
      respondWith('<p>This page has enough words to keep.</p>');

      const result = await loadWebPage('http://[64:ff9b::8.8.8.8]/');

      expect(result).toBe('This page has enough words to keep.');
      expect(String(sentRequests[0].url)).toBe('http://[64:ff9b::808:808]/');
      expect(pinnedLookupResults(sentRequests[0])).toEqual({
        single: '64:ff9b::808:808',
        all: [{address: '64:ff9b::808:808', family: 6}],
      });
    });
  });

  describe('connection pinning', () => {
    it('pins the connection to the resolved address without rewriting the URL', async () => {
      resolveTo('93.184.216.34');
      respondWith('<p>This page has enough words to keep.</p>');

      const result = await loadWebPage('https://example.com/search?q=adk');

      expect(result).toBe('This page has enough words to keep.');
      expect(String(sentRequests[0].url)).toBe(
        'https://example.com/search?q=adk',
      );
      expect(sentRequests[0].options.servername).toBe('example.com');
      expect(pinnedLookupResults(sentRequests[0])).toEqual({
        single: '93.184.216.34',
        all: [{address: '93.184.216.34', family: 4}],
      });
    });

    it('omits the TLS server name when the host is an IP literal', async () => {
      respondWith('<p>This page has enough words to keep.</p>');

      const result = await loadWebPage('https://93.184.216.34/');

      expect(result).toBe('This page has enough words to keep.');
      expect(sentRequests[0].options.servername).toBeUndefined();
    });

    it('asks for an identity encoding so the body needs no decompression', async () => {
      resolveTo('93.184.216.34');
      respondWith('<p>This page has enough words to keep.</p>');

      await loadWebPage('https://example.com/');

      expect(sentRequests[0].options.headers).toEqual({
        'accept-encoding': 'identity',
      });
    });

    it('tries the next resolved address after a transport error', async () => {
      resolveTo('93.184.216.34', '93.184.216.35');
      onRequestEnd = (request) => {
        if (sentRequests.length === 1) {
          request.emit('error', new Error('first address failed'));
          return;
        }
        emitResponse(request, '<p>This page has enough words to keep.</p>');
      };

      const result = await loadWebPage('https://example.com');

      expect(result).toBe('This page has enough words to keep.');
      expect(
        sentRequests.map((request) => pinnedLookupResults(request).single),
      ).toEqual(['93.184.216.34', '93.184.216.35']);
    });

    it('returns the failure string when every resolved address fails', async () => {
      resolveTo('93.184.216.34', '93.184.216.35');
      onRequestEnd = (request) => {
        request.emit('error', new Error('connect failed'));
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
      expect(sentRequests).toHaveLength(2);
    });

    it('does not try the next address when the first one answers non-200', async () => {
      resolveTo('93.184.216.34', '93.184.216.35');
      respondWith('<p>ignored body here</p>', {status: 404});

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
      expect(sentRequests).toHaveLength(1);
    });
  });

  describe('proxy option', () => {
    const PROXY = 'http://proxy.example.test:8080';

    it('reaches a hostname the proxy resolves, without a local DNS lookup', async () => {
      respondThroughTunnel('<p>This page has enough words to keep.</p>');

      const result = await loadWebPage('https://does-not-resolve.invalid', {
        proxy: PROXY,
      });

      expect(result).toBe('This page has enough words to keep.');
      expect(lookupMock).not.toHaveBeenCalled();
      expect(sentRequests[0].options).toMatchObject({
        host: 'proxy.example.test',
        method: 'CONNECT',
        path: 'does-not-resolve.invalid:443',
        port: 8080,
      });
      expect(tlsConnectMock).toHaveBeenCalledWith(
        expect.objectContaining({servername: 'does-not-resolve.invalid'}),
      );
      expect(sentRequests[1].options.createConnection?.({}, () => {})).toBe(
        tlsConnectMock.mock.results[0].value,
      );
    });

    it('ignores the proxy environment variables', async () => {
      // An ambient proxy must not switch address vetting off, so a hostname
      // still takes the resolved-and-vetted path.
      vi.stubEnv('https_proxy', PROXY);
      vi.stubEnv('HTTPS_PROXY', PROXY);
      vi.stubEnv('all_proxy', PROXY);
      resolveTo('169.254.169.254');
      respondThroughTunnel('<p>This body must never be returned.</p>');

      const result = await loadWebPage('https://metadata.example/');

      expect(result).toBe('Failed to fetch url: https://metadata.example/');
      expect(lookupMock).toHaveBeenCalledWith('metadata.example', {all: true});
      expectNoRequest();
    });

    it('gives the tunnelled request no agent, so Node uses the tunnel socket', async () => {
      respondThroughTunnel('<p>This page has enough words to keep.</p>');

      await loadWebPage('https://does-not-resolve.invalid/', {proxy: PROXY});

      // Node consults `createConnection` only when the request has no agent,
      // and `agent: false` builds a fresh one. Setting it here would send the
      // request down a direct, unvetted connection.
      expect(sentRequests[1].options).not.toHaveProperty('agent');
      expect(sentRequests[1].options.createConnection).toBeInstanceOf(Function);
    });

    it('fails when the tunnelled request lands on another socket', async () => {
      onRequestEnd = (request) => {
        if (request.options.method === 'CONNECT') {
          request.emit('connect', {statusCode: 200}, new FakeSocket());
          return;
        }
        request.emit('socket', new FakeSocket());
        emitResponse(request, '<p>This body must never be returned.</p>');
      };

      const result = await loadWebPage('https://does-not-resolve.invalid/', {
        proxy: PROXY,
      });

      expect(result).toBe(
        'Failed to fetch url: https://does-not-resolve.invalid/',
      );
    });

    it('accepts the tunnelled request that lands on the tunnel socket', async () => {
      onRequestEnd = (request) => {
        if (request.options.method === 'CONNECT') {
          request.emit('connect', {statusCode: 200}, new FakeSocket());
          return;
        }
        request.emit('socket', tlsConnectMock.mock.results[0].value);
        emitResponse(request, '<p>This page has enough words to keep.</p>');
      };

      const result = await loadWebPage('https://does-not-resolve.invalid/', {
        proxy: PROXY,
      });

      expect(result).toBe('This page has enough words to keep.');
    });

    it('destroys the tunnel socket once the request is done', async () => {
      respondThroughTunnel('<p>This page has enough words to keep.</p>');

      await loadWebPage('https://does-not-resolve.invalid/', {proxy: PROXY});

      expect(tlsConnectMock.mock.results[0].value.destroy).toHaveBeenCalled();
    });

    it('sends an http target in absolute form instead of opening a tunnel', async () => {
      respondWith('<p>This page has enough words to keep.</p>');

      const result = await loadWebPage('http://does-not-resolve.invalid/page', {
        proxy: PROXY,
      });

      expect(result).toBe('This page has enough words to keep.');
      expect(tlsConnectMock).not.toHaveBeenCalled();
      expect(sentRequests[0].options).toMatchObject({
        host: 'proxy.example.test',
        path: 'http://does-not-resolve.invalid/page',
      });
      expect(sentRequests[0].options.headers).toMatchObject({
        host: 'does-not-resolve.invalid',
      });
    });

    it('sends proxy credentials as a Basic Proxy-Authorization header', async () => {
      const credentials = `${PROXY_USER}:${PROXY_SECRET}`;
      respondWith('<p>This page has enough words to keep.</p>');

      await loadWebPage('http://does-not-resolve.invalid/page', {
        proxy: `http://${credentials}@proxy.example.test:8080`,
      });

      expect(sentRequests[0].options.headers).toMatchObject({
        'proxy-authorization': `Basic ${Buffer.from(credentials).toString('base64')}`,
      });
    });

    it('returns the failure string when the proxy refuses the tunnel', async () => {
      respondThroughTunnel('<p>never read</p>', 407);

      const result = await loadWebPage('https://does-not-resolve.invalid/', {
        proxy: PROXY,
      });

      expect(result).toBe(
        'Failed to fetch url: https://does-not-resolve.invalid/',
      );
    });

    it('returns the failure string for a proxy scheme it cannot speak', async () => {
      const result = await loadWebPage('https://example.com/', {
        proxy: 'socks5://proxy.example.test:1080',
      });

      expect(result).toBe('Failed to fetch url: https://example.com/');
      expectNoRequest();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('defaults the proxy port from its scheme', async () => {
      respondWith('<p>This page has enough words to keep.</p>');

      await loadWebPage('http://does-not-resolve.invalid/page', {
        proxy: 'http://proxy.example.test',
      });

      expect(sentRequests[0].options.port).toBe(80);
    });

    it('vets an IP literal before handing it to the proxy', async () => {
      const result = await loadWebPage('http://169.254.169.254/', {
        proxy: PROXY,
      });

      expect(result).toBe('Failed to fetch url: http://169.254.169.254/');
      expectNoRequest();
    });
  });

  describe('response and transport failures', () => {
    it.each([301, 302, 404, 500])(
      'returns the failure string for non-200 status %i',
      async (status) => {
        resolveTo('93.184.216.34');
        respondWith('<p>ignored body here</p>', {status});

        const result = await loadWebPage('https://example.com/');

        expect(result).toBe('Failed to fetch url: https://example.com/');
      },
    );

    it('returns the failure string when the request times out', async () => {
      resolveTo('93.184.216.34');
      onRequestEnd = (request) => {
        request.destroy(new Error('The operation timed out.'));
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });

    it('returns the failure string on a network error', async () => {
      resolveTo('93.184.216.34');
      onRequestEnd = (request) => {
        request.emit('error', new TypeError('network failure'));
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });

    it('returns the failure string when the body exceeds the size cap', async () => {
      resolveTo('93.184.216.34');
      respondWith(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });

    it('reads a body that stops just under the size cap', async () => {
      resolveTo('93.184.216.34');
      const body = Buffer.concat([
        Buffer.from('<p>This page has enough words to keep.</p>'),
        Buffer.alloc(1024, 0x20),
      ]);
      respondWith(body);

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('This page has enough words to keep.');
    });

    it('returns the failure string when the response stream errors', async () => {
      resolveTo('93.184.216.34');
      onRequestEnd = (request) => {
        const response = Object.assign(
          new Readable({
            read() {
              this.destroy(new Error('stream broke'));
            },
          }),
          {statusCode: 200, headers: {}},
        );
        request.emit('response', response);
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });
  });

  describe('body decoding', () => {
    it.each([
      ['&#8212;', '—'],
      ['&#x2014;', '—'],
      ['&apos;', "'"],
      ['&quot;', '"'],
      ['&lt;', '<'],
    ])('decodes the entity %s', async (entity, decoded) => {
      resolveTo('93.184.216.34');
      respondWith(`<p>A line long enough ${entity} to keep</p>`);

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe(`A line long enough ${decoded} to keep`);
    });

    it('decodes an escaped entity only once', async () => {
      resolveTo('93.184.216.34');
      respondWith('<p>The markup uses &amp;lt; for a tag</p>');

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('The markup uses &lt; for a tag');
    });

    it('leaves a named entity outside the table alone', async () => {
      resolveTo('93.184.216.34');
      respondWith('<p>An em dash &mdash; stays as written here</p>');

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('An em dash &mdash; stays as written here');
    });

    it('leaves an unknown or out-of-range entity alone', async () => {
      resolveTo('93.184.216.34');
      respondWith('<p>Both &notanentity; and &#1114112; stay put</p>');

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Both &notanentity; and &#1114112; stay put');
    });

    it('decodes the body with the charset the response declares', async () => {
      resolveTo('93.184.216.34');
      respondWith(
        Buffer.from('<p>Caf\xe9 has enough words here</p>', 'latin1'),
        {
          headers: {'content-type': 'text/html; charset=iso-8859-1'},
        },
      );

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Café has enough words here');
    });

    it('falls back to UTF-8 for an unknown charset', async () => {
      resolveTo('93.184.216.34');
      respondWith('<p>Café has enough words here</p>', {
        headers: {'content-type': 'text/html; charset=not-a-charset'},
      });

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Café has enough words here');
    });
  });

  describe('timeout configuration', () => {
    it('uses the 30s default and honors an override', async () => {
      vi.useFakeTimers();
      resolveTo('93.184.216.34');

      const pendingDefault = loadWebPage('https://example.com/');
      await vi.advanceTimersByTimeAsync(29_999);
      expect(sentRequests[0].destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(sentRequests[0].destroyed).toBe(true);
      expect(await pendingDefault).toBe(
        'Failed to fetch url: https://example.com/',
      );

      const pendingOverride = loadWebPage('https://example.com/', {
        timeoutMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentRequests[1].destroyed).toBe(true);
      expect(await pendingOverride).toBe(
        'Failed to fetch url: https://example.com/',
      );
    });

    it('falls back to the default when options omit timeoutMs', async () => {
      vi.useFakeTimers();
      resolveTo('93.184.216.34');

      const pending = loadWebPage('https://example.com/', {});
      await vi.advanceTimersByTimeAsync(29_999);
      expect(sentRequests[0].destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBe('Failed to fetch url: https://example.com/');
    });

    it('applies the deadline to the proxy tunnel', async () => {
      vi.useFakeTimers();

      const pending = loadWebPage('https://does-not-resolve.invalid/', {
        proxy: 'http://proxy.example.test:8080',
      });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(sentRequests[0].options.method).toBe('CONNECT');
      expect(sentRequests[0].destroyed).toBe(true);
      expect(await pending).toBe(
        'Failed to fetch url: https://does-not-resolve.invalid/',
      );
    });

    it('shares one deadline between the tunnel and the request it carries', async () => {
      vi.useFakeTimers();
      onRequestEnd = (request) => {
        if (request.options.method !== 'CONNECT') {
          return;
        }
        setTimeout(() => {
          request.emit('connect', {statusCode: 200}, new FakeSocket());
        }, 20_000);
      };

      const pending = loadWebPage('https://does-not-resolve.invalid/', {
        proxy: 'http://proxy.example.test:8080',
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sentRequests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(sentRequests[1].destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(sentRequests[1].destroyed).toBe(true);
      expect(await pending).toBe(
        'Failed to fetch url: https://does-not-resolve.invalid/',
      );
    });

    it('bounds the whole call, not each address attempt', async () => {
      vi.useFakeTimers();
      resolveTo('93.184.216.34', '93.184.216.35');

      const pending = loadWebPage('https://example.com/');
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBe('Failed to fetch url: https://example.com/');
      expect(sentRequests).toHaveLength(2);
      expect(sentRequests.map((request) => request.destroyed)).toEqual([
        true,
        true,
      ]);
    });

    it('clears the deadline once the response arrives', async () => {
      vi.useFakeTimers();
      resolveTo('93.184.216.34');
      respondWith('<p>This page has enough words to keep.</p>');

      const result = await loadWebPage('https://example.com/');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(result).toBe('This page has enough words to keep.');
      expect(sentRequests[0].destroyed).toBe(false);
    });
  });
});

describe('LOAD_WEB_PAGE tool', () => {
  it('is a FunctionTool exposing a load_web_page declaration', () => {
    expect(LOAD_WEB_PAGE).toBeInstanceOf(FunctionTool);

    const declaration = LOAD_WEB_PAGE._getDeclaration();
    expect(declaration?.name).toBe('load_web_page');
    expect(declaration?.parameters?.properties?.['url']).toBeDefined();
  });

  it('runs through the tool interface and returns the parity failure string', async () => {
    const result = await LOAD_WEB_PAGE.runAsync({
      args: {url: 'file:///etc/passwd'},
      toolContext: {} as never,
    });

    expect(result).toBe('Failed to fetch url: file:///etc/passwd');
  });
});
