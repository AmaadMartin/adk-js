/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {lookup} from 'node:dns/promises';
import {
  createServer,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type {RequestOptions} from 'node:https';
import {connect as netConnect, type Socket} from 'node:net';
import type {ConnectionOptions, TLSSocket} from 'node:tls';

import {FunctionTool, LOAD_WEB_PAGE, loadWebPage} from '@google/adk';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  Mock,
  vi,
} from 'vitest';

/**
 * The options the tool builds. `RequestOptions.headers` is a union with
 * `readonly string[]`, a form the tool never uses; narrowing it here keeps the
 * header assertions free of casts.
 */
type CapturedOptions = Omit<RequestOptions, 'headers'> & {
  headers?: OutgoingHttpHeaders;
};

/**
 * The transport is spied on rather than replaced: every implementation below
 * calls the real `node:http` / `node:https` / `node:tls` client, so the tests
 * exercise real sockets against local servers while still asserting the
 * connection options the tool chose.
 */
const {httpRequestSpy, httpsRequestSpy, tlsConnectSpy} = vi.hoisted(() => ({
  httpRequestSpy: vi.fn<(options: CapturedOptions) => ClientRequest>(),
  httpsRequestSpy: vi.fn<(options: CapturedOptions) => ClientRequest>(),
  tlsConnectSpy: vi.fn<(options: ConnectionOptions) => TLSSocket>(),
}));

vi.mock('node:dns/promises', () => ({lookup: vi.fn()}));

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: httpRequestSpy,
}));

vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  request: httpsRequestSpy,
}));

vi.mock('node:tls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tls')>()),
  connect: tlsConnectSpy,
}));

const actualHttp =
  await vi.importActual<typeof import('node:http')>('node:http');
const actualHttps =
  await vi.importActual<typeof import('node:https')>('node:https');
const actualTls = await vi.importActual<typeof import('node:tls')>('node:tls');

// `lookup` is overloaded; treat the mock as a plain Mock so `mockResolvedValue`
// accepts the `{all: true}` array-return shape used by the implementation.
const lookupMock = lookup as unknown as Mock;

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
];

/** Fake proxy credentials, assembled so no literal `user:pass@` appears. */
const PROXY_CREDENTIALS = ['agent', 'not-a-real-secret'].join(':');

/** A `tunnelStatus` that makes the proxy accept a CONNECT and never answer. */
const TUNNEL_NO_ANSWER = 0;

const PAGE_HTML =
  '<html><body><p>This page has enough words to keep.</p>' +
  '<p>tiny</p></body></html>';
const PAGE_TEXT = 'This page has enough words to keep.';

/** What a local server saw, enough to assert the request that reached it. */
interface ReceivedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

/** Binds `server` to an ephemeral loopback port and returns that port. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    return expect.fail('the test server did not bind a TCP port');
  }
  return address.port;
}

/** Closes `server` and waits for its listeners to go away. */
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Responds with `PAGE_HTML` and a 200 status. */
function servePage(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {'Content-Type': 'text/html'});
  response.end(PAGE_HTML);
}

/** Sends headers promising a body, then drops the connection mid-body. */
function truncatePage(
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Length': '1000',
  });
  response.write(PAGE_HTML, () => response.destroy());
}

/** Every request the tool created, in order, with its timeout call recorded. */
const sentRequests: ClientRequest[] = [];

/** Records `request` so a test can assert the timeout the tool applied. */
function track(request: ClientRequest): ClientRequest {
  sentRequests.push(request);
  vi.spyOn(request, 'setTimeout');
  return request;
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

describe('loadWebPage', () => {
  const originRequests: ReceivedRequest[] = [];
  const proxyRequests: ReceivedRequest[] = [];
  /** Sockets the proxy accepted but never answered, closed after each test. */
  const parkedSockets: Socket[] = [];
  let originHandler: (req: IncomingMessage, res: ServerResponse) => void;
  let tunnelStatus: number;
  let origin: Server;
  let proxy: Server;
  let originPort: number;
  let proxyPort: number;
  let closedPort: number;

  /**
   * Points the transport at the local origin server while keeping the
   * requested address in `options.hostname`, so a test can assert which
   * address the tool pinned to without connecting to it.
   */
  function pinToOrigin(failingAddresses: string[] = []): void {
    const redirect = (options: CapturedOptions) => {
      const port = failingAddresses.includes(String(options.hostname))
        ? closedPort
        : originPort;
      return track(
        actualHttp.request({...options, hostname: '127.0.0.1', port}),
      );
    };
    httpRequestSpy.mockImplementation(redirect);
    // A local TLS origin would need a certificate, so an `https:` target is
    // carried over a plain connection. The assertions are on the options the
    // tool handed to `https.request`, which is where TLS is configured.
    httpsRequestSpy.mockImplementation(redirect);
  }

  /** The options the tool passed to `https.request` on its `index`-th call. */
  function tlsRequestOptions(index = 0): CapturedOptions {
    return httpsRequestSpy.mock.calls[index][0];
  }

  /** The options the tool passed to `http.request` on its `index`-th call. */
  function plainRequestOptions(index = 0): CapturedOptions {
    return httpRequestSpy.mock.calls[index][0];
  }

  beforeAll(async () => {
    origin = createServer((req, res) => {
      originRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
      });
      originHandler(req, res);
    });
    proxy = createServer((req, res) => {
      proxyRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
      });
      originHandler(req, res);
    });
    proxy.on('connect', (req: IncomingMessage, socket: Socket) => {
      proxyRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
      });
      if (tunnelStatus === TUNNEL_NO_ANSWER) {
        parkedSockets.push(socket);
        return;
      }
      if (tunnelStatus !== 200) {
        socket.end(`HTTP/1.1 ${tunnelStatus} Forbidden\r\n\r\n`);
        return;
      }
      const upstream = netConnect({host: '127.0.0.1', port: originPort});
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    originPort = await listen(origin);
    proxyPort = await listen(proxy);
    const spare = createServer();
    closedPort = await listen(spare);
    await close(spare);
  });

  afterAll(async () => {
    await close(origin);
    await close(proxy);
  });

  beforeEach(() => {
    originRequests.length = 0;
    proxyRequests.length = 0;
    originHandler = servePage;
    tunnelStatus = 200;
    lookupMock.mockReset();
    httpRequestSpy.mockReset();
    httpsRequestSpy.mockReset();
    tlsConnectSpy.mockReset();
    sentRequests.length = 0;
    httpRequestSpy.mockImplementation((options) =>
      track(actualHttp.request(options)),
    );
    httpsRequestSpy.mockImplementation((options) =>
      track(actualHttps.request(options)),
    );
    tlsConnectSpy.mockImplementation((options) => actualTls.connect(options));
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    for (const socket of parkedSockets) {
      socket.destroy();
    }
    parkedSockets.length = 0;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('url rejection before any network access', () => {
    it('rejects non-http(s) schemes without resolving or requesting', async () => {
      const result = await loadWebPage('file:///etc/passwd');

      expect(result).toBe('Failed to fetch url: file:///etc/passwd');
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects malformed URLs', async () => {
      const result = await loadWebPage('not a url');

      expect(result).toBe('Failed to fetch url: not a url');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it.each([
      'http://example.com:99999/',
      'http://example.com:0x50/',
      `http://${PROXY_CREDENTIALS}@example.com:99999/path`,
      'http://[2606:4700:4700::1111]:70000/',
    ])('rejects the invalid port in %s', async (url) => {
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects the localhost hostname', async () => {
      const result = await loadWebPage('http://localhost:8080/');

      expect(result).toBe('Failed to fetch url: http://localhost:8080/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects *.localhost hostnames', async () => {
      const result = await loadWebPage('http://api.localhost./');

      expect(result).toBe('Failed to fetch url: http://api.localhost./');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('SSRF address rejection', () => {
    it('rejects loopback IPv4 literals without a DNS lookup', async () => {
      const url =
        'http://127.0.0.1:19876/latest/meta-data/iam/security-credentials/';

      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects shared address space (CGNAT) IPv4 literals', async () => {
      const result = await loadWebPage('http://100.64.0.1/internal');

      expect(result).toBe('Failed to fetch url: http://100.64.0.1/internal');
      expect(httpRequestSpy).not.toHaveBeenCalled();
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
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('rejects a NAT64 address wrapping the metadata endpoint', async () => {
      const url = 'http://[64:ff9b::169.254.169.254]/computeMetadata/v1/';

      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects an IPv4-compatible address wrapping a private IPv4', async () => {
      const url = 'http://[::169.254.169.254]/latest/meta-data/';

      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('rejects a 6to4 address wrapping loopback', async () => {
      const result = await loadWebPage('http://[2002:7f00:1::]/');

      expect(result).toBe('Failed to fetch url: http://[2002:7f00:1::]/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('rejects a private IP discovered via DNS resolution', async () => {
      resolveTo('169.254.169.254');

      const url = 'http://metadata.google.internal/computeMetadata/v1/';
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(lookupMock).toHaveBeenCalledWith('metadata.google.internal', {
        all: true,
      });
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('rejects when any of several resolved addresses is non-global', async () => {
      resolveTo('93.184.216.34', '10.0.0.5');

      const result = await loadWebPage('http://mixed.example/');

      expect(result).toBe('Failed to fetch url: http://mixed.example/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('fails closed when DNS resolves to an unparseable address', async () => {
      resolveTo('not-an-ip');

      const result = await loadWebPage('http://weird.example/');

      expect(result).toBe('Failed to fetch url: http://weird.example/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('fails closed when DNS resolves to an out-of-range IPv4', async () => {
      resolveTo('1.2.3.999');

      const result = await loadWebPage('http://weird.example/');

      expect(result).toBe('Failed to fetch url: http://weird.example/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('fails when DNS resolution returns no addresses', async () => {
      lookupMock.mockResolvedValue([]);

      const result = await loadWebPage('http://empty.example/');

      expect(result).toBe('Failed to fetch url: http://empty.example/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('fails when DNS resolution throws', async () => {
      lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

      const result = await loadWebPage('http://missing.example/');

      expect(result).toBe('Failed to fetch url: http://missing.example/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('rejects IPv6 loopback literals', async () => {
      const result = await loadWebPage('http://[::1]/');

      expect(result).toBe('Failed to fetch url: http://[::1]/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it.each([
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[ff02::1]/',
      'http://[2001:db8::1]/',
      'http://[2001::1]/',
      'http://[::]/',
    ])('rejects non-global IPv6 literal %s', async (url) => {
      const result = await loadWebPage(url);

      expect(result).toBe(`Failed to fetch url: ${url}`);
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });

    it('rejects an IPv4-mapped IPv6 address pointing at a private IP', async () => {
      resolveTo('::ffff:127.0.0.1');

      const result = await loadWebPage('http://mapped.example/');

      expect(result).toBe('Failed to fetch url: http://mapped.example/');
      expect(httpRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('pinning the connection to the vetted address', () => {
    it('connects to the resolved address and keeps the original host', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();

      const result = await loadWebPage('https://example.com/search?q=adk');

      expect(result).toBe(PAGE_TEXT);
      expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
      const options = tlsRequestOptions();
      expect(options.hostname).toBe('93.184.216.34');
      expect(options.port).toBe(443);
      expect(options.path).toBe('/search?q=adk');
      expect(options.setHost).toBe(false);
      expect(options.headers?.['Host']).toBe('example.com');
      expect(options.servername).toBe('example.com');
      expect(originRequests[0].headers.host).toBe('example.com');
      expect(originRequests[0].url).toBe('/search?q=adk');
    });

    it('excludes the fragment from the request path', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();

      await loadWebPage('https://example.com/a?q=1#section');

      expect(tlsRequestOptions().path).toBe('/a?q=1');
      expect(originRequests[0].url).toBe('/a?q=1');
    });

    it('keeps a non-default port in the Host header', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();

      await loadWebPage('https://example.com:8443/');

      const options = tlsRequestOptions();
      expect(options.port).toBe(8443);
      expect(options.headers?.['Host']).toBe('example.com:8443');
      expect(originRequests[0].headers.host).toBe('example.com:8443');
    });

    it('drops the default port from the Host header', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();

      await loadWebPage('http://example.com:80/a');

      expect(httpsRequestSpy).not.toHaveBeenCalled();
      const options = plainRequestOptions();
      expect(options.port).toBe(80);
      expect(options.headers?.['Host']).toBe('example.com');
    });

    it('sends no TLS server name for an IP-literal target', async () => {
      pinToOrigin();

      const result = await loadWebPage('https://[2606:4700:4700::1111]/');

      expect(result).toBe(PAGE_TEXT);
      expect(lookupMock).not.toHaveBeenCalled();
      const options = tlsRequestOptions();
      expect(options.servername).toBeUndefined();
      expect(options.hostname).toBe('2606:4700:4700::1111');
      expect(options.headers?.['Host']).toBe('[2606:4700:4700::1111]');
    });

    it('connects to a public NAT64 address in its canonical form', async () => {
      pinToOrigin();

      // WHATWG canonicalizes the embedded dotted quad to hex, so the address
      // and the Host header both read `64:ff9b::808:808`.
      const result = await loadWebPage('http://[64:ff9b::8.8.8.8]/');

      expect(result).toBe(PAGE_TEXT);
      const options = plainRequestOptions();
      expect(options.hostname).toBe('64:ff9b::808:808');
      expect(options.headers?.['Host']).toBe('[64:ff9b::808:808]');
    });

    it('tries the next resolved address after a transport failure', async () => {
      resolveTo('93.184.216.34', '93.184.216.35');
      pinToOrigin(['93.184.216.34']);

      const result = await loadWebPage('https://example.com');

      expect(result).toBe(PAGE_TEXT);
      expect(httpsRequestSpy).toHaveBeenCalledTimes(2);
      expect(tlsRequestOptions(0).hostname).toBe('93.184.216.34');
      expect(tlsRequestOptions(1).hostname).toBe('93.184.216.35');
    });

    it('returns the failure string when every address fails', async () => {
      resolveTo('93.184.216.34', '93.184.216.35');
      pinToOrigin(['93.184.216.34', '93.184.216.35']);

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
      expect(httpsRequestSpy).toHaveBeenCalledTimes(2);
      expect(originRequests).toHaveLength(0);
    });

    it('de-duplicates repeated addresses before connecting', async () => {
      resolveTo('93.184.216.34', '93.184.216.34');
      pinToOrigin();

      await loadWebPage('https://example.com/');

      expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('response handling', () => {
    it('drops lines with three or fewer words', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe(PAGE_TEXT);
    });

    it('strips <script> and <style> blocks and decodes entities', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();
      originHandler = (_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(
          '<html><head><style>.a{color:red}</style>' +
            '<script>var secret = "do not leak this";</script></head>' +
            '<body><!-- a comment that should vanish -->' +
            '<p>Fish &amp; chips are quite tasty today</p></body></html>',
        );
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Fish & chips are quite tasty today');
      expect(result).not.toContain('secret');
      expect(result).not.toContain('color:red');
      expect(result).not.toContain('comment');
    });

    it('decodes the body with the charset the response declares', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();
      originHandler = (_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html; charset=iso-8859-1'});
        res.end(
          Buffer.from('<p>Caf\u00e9 serves very good cake</p>', 'latin1'),
        );
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Café serves very good cake');
    });

    it('falls back to UTF-8 for a charset the runtime does not know', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();
      originHandler = (_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html; charset=nonsense-9'});
        res.end('<p>Caf\u00e9 serves very good cake</p>');
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Café serves very good cake');
    });

    it('allows a global IPv6 literal target', async () => {
      pinToOrigin();
      originHandler = (_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<p>The quick brown fox jumped over here</p>');
      };

      const result = await loadWebPage('http://[2606:4700:4700::1111]/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(httpRequestSpy).toHaveBeenCalledTimes(1);
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('allows a global IPv6 address resolved via DNS (full form)', async () => {
      resolveTo('2606:4700:4700:0:0:0:0:1111');
      pinToOrigin();
      originHandler = (_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<p>The quick brown fox jumped over here</p>');
      };

      const result = await loadWebPage('http://ipv6.example/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(httpRequestSpy).toHaveBeenCalledTimes(1);
      expect(plainRequestOptions().hostname).toBe(
        '2606:4700:4700:0:0:0:0:1111',
      );
    });

    it('allows an IPv4-mapped IPv6 address pointing at a public IP', async () => {
      resolveTo('::ffff:93.184.216.34');
      pinToOrigin();
      originHandler = (_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<p>The quick brown fox jumped over here</p>');
      };

      const result = await loadWebPage('http://mapped-public.example/');

      expect(result).toBe('The quick brown fox jumped over here');
      expect(httpRequestSpy).toHaveBeenCalledTimes(1);
      expect(plainRequestOptions().hostname).toBe('::ffff:93.184.216.34');
    });

    it('returns an empty string when no line has enough words', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();
      originHandler = (_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<p>too short</p>');
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('');
    });

    it.each([301, 302, 404, 500])(
      'returns the failure string for status %i without following it',
      async (status) => {
        resolveTo('93.184.216.34');
        pinToOrigin();
        originHandler = (_req, res) => {
          res.writeHead(status, {Location: 'http://169.254.169.254/'});
          res.end('<p>ignored body goes here</p>');
        };

        const result = await loadWebPage('https://example.com/');

        expect(result).toBe('Failed to fetch url: https://example.com/');
        expect(originRequests).toHaveLength(1);
      },
    );

    it('abandons a body larger than the 10 MiB cap', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();
      originHandler = (_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        const megabyte = Buffer.alloc(1024 * 1024, 0x61);
        for (let written = 0; written <= 10; written++) {
          res.write(megabyte);
        }
        res.end();
      };

      const result = await loadWebPage('https://example.com/');

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });
  });

  describe('timeouts', () => {
    it('applies the 30s default and honours an override', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();

      await loadWebPage('https://example.com/');
      expect(vi.mocked(sentRequests[0].setTimeout)).toHaveBeenCalledWith(
        30_000,
        expect.any(Function),
      );

      await loadWebPage('https://example.com/', {timeoutMs: 5000});
      expect(vi.mocked(sentRequests[1].setTimeout)).toHaveBeenCalledWith(
        5000,
        expect.any(Function),
      );
    });

    it('falls back to the default when options omit timeoutMs', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();

      await loadWebPage('https://example.com/', {});

      expect(vi.mocked(sentRequests[0].setTimeout)).toHaveBeenCalledWith(
        30_000,
        expect.any(Function),
      );
    });

    it('returns the failure string when the origin drops the connection mid-body', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();
      originHandler = truncatePage;

      const result = await loadWebPage('https://example.com/', {
        timeoutMs: 1000,
      });

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });

    it('returns the failure string when the origin never responds', async () => {
      resolveTo('93.184.216.34');
      pinToOrigin();
      originHandler = () => {};

      const result = await loadWebPage('https://example.com/', {timeoutMs: 50});

      expect(result).toBe('Failed to fetch url: https://example.com/');
    });
  });

  describe('proxy path', () => {
    it('sends an absolute-form request URI for an http: target', async () => {
      vi.stubEnv('http_proxy', `http://127.0.0.1:${proxyPort}`);

      const result = await loadWebPage('http://example.com/page?q=1#top');

      expect(result).toBe(PAGE_TEXT);
      expect(lookupMock).not.toHaveBeenCalled();
      expect(proxyRequests).toHaveLength(1);
      expect(proxyRequests[0].url).toBe('http://example.com/page?q=1');
      expect(proxyRequests[0].headers.host).toBe('example.com');
    });

    it('uses all_proxy when the scheme has no proxy of its own', async () => {
      vi.stubEnv('ALL_PROXY', `http://127.0.0.1:${proxyPort}`);

      const result = await loadWebPage('http://example.com/page');

      expect(result).toBe(PAGE_TEXT);
      expect(proxyRequests).toHaveLength(1);
    });

    it('authenticates to a proxy that carries credentials', async () => {
      vi.stubEnv(
        'http_proxy',
        `http://${PROXY_CREDENTIALS}@127.0.0.1:${proxyPort}`,
      );

      await loadWebPage('http://example.com/page');

      expect(proxyRequests[0].headers['proxy-authorization']).toBe(
        `Basic ${Buffer.from(PROXY_CREDENTIALS).toString('base64')}`,
      );
    });

    it('applies the timeout to the proxied request', async () => {
      vi.stubEnv('http_proxy', `http://127.0.0.1:${proxyPort}`);

      await loadWebPage('http://example.com/page', {timeoutMs: 7000});

      expect(vi.mocked(sentRequests[0].setTimeout)).toHaveBeenCalledWith(
        7000,
        expect.any(Function),
      );
    });

    it('takes the direct pinned path when no_proxy covers the host', async () => {
      vi.stubEnv('http_proxy', `http://127.0.0.1:${proxyPort}`);
      vi.stubEnv('no_proxy', '.example.com');
      resolveTo('93.184.216.34');
      pinToOrigin();

      const result = await loadWebPage('http://example.com/page');

      expect(result).toBe(PAGE_TEXT);
      expect(lookupMock).toHaveBeenCalledWith('example.com', {all: true});
      expect(plainRequestOptions().hostname).toBe('93.184.216.34');
      expect(proxyRequests).toHaveLength(0);
    });

    it('still refuses a blocked IP literal when a proxy is configured', async () => {
      vi.stubEnv('http_proxy', `http://127.0.0.1:${proxyPort}`);

      const result = await loadWebPage('http://127.0.0.1/admin');

      expect(result).toBe('Failed to fetch url: http://127.0.0.1/admin');
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(proxyRequests).toHaveLength(0);
    });

    it('returns the failure string when the proxy drops the connection mid-body', async () => {
      vi.stubEnv('http_proxy', `http://127.0.0.1:${proxyPort}`);
      originHandler = truncatePage;

      const result = await loadWebPage('http://example.com/page', {
        timeoutMs: 1000,
      });

      expect(result).toBe('Failed to fetch url: http://example.com/page');
    });

    it('returns the failure string when the proxy is unreachable', async () => {
      vi.stubEnv('http_proxy', `http://127.0.0.1:${closedPort}`);

      const result = await loadWebPage('http://example.com/page');

      expect(result).toBe('Failed to fetch url: http://example.com/page');
    });

    it('opens a CONNECT tunnel for an https: target', async () => {
      vi.stubEnv('https_proxy', `http://127.0.0.1:${proxyPort}`);

      // The tunnelled origin speaks plain HTTP, so the TLS handshake fails and
      // the tool reports the failure. What this pins is everything before it:
      // the CONNECT authority, the absence of a local lookup, and the server
      // name the tool asks TLS to verify.
      const result = await loadWebPage('https://does-not-resolve.invalid/doc');

      expect(result).toBe(
        'Failed to fetch url: https://does-not-resolve.invalid/doc',
      );
      expect(lookupMock).not.toHaveBeenCalled();
      expect(proxyRequests).toHaveLength(1);
      expect(proxyRequests[0].method).toBe('CONNECT');
      expect(proxyRequests[0].url).toBe('does-not-resolve.invalid:443');
      expect(tlsConnectSpy).toHaveBeenCalledTimes(1);
      expect(tlsConnectSpy.mock.calls[0][0].servername).toBe(
        'does-not-resolve.invalid',
      );
      expect(tlsConnectSpy.mock.calls[0][0].host).toBe(
        'does-not-resolve.invalid',
      );
    });

    it('verifies an IP-literal tunnel target against the IP, not the proxy', async () => {
      vi.stubEnv('https_proxy', `http://127.0.0.1:${proxyPort}`);

      await loadWebPage('https://[2606:4700:4700::1111]/doc');

      expect(proxyRequests[0].url).toBe('[2606:4700:4700::1111]:443');
      // RFC 6066 forbids an IP literal as a server name, so `host` is what
      // Node checks the certificate against.
      expect(tlsConnectSpy.mock.calls[0][0].servername).toBeUndefined();
      expect(tlsConnectSpy.mock.calls[0][0].host).toBe('2606:4700:4700::1111');
    });

    it('names the explicit port in the CONNECT authority', async () => {
      vi.stubEnv('https_proxy', `http://127.0.0.1:${proxyPort}`);

      await loadWebPage('https://example.com:8443/doc');

      expect(proxyRequests[0].url).toBe('example.com:8443');
    });

    it('authenticates a CONNECT to a proxy that carries credentials', async () => {
      vi.stubEnv(
        'https_proxy',
        `http://${PROXY_CREDENTIALS}@127.0.0.1:${proxyPort}`,
      );

      await loadWebPage('https://example.com/doc');

      expect(proxyRequests[0].headers['proxy-authorization']).toBe(
        `Basic ${Buffer.from(PROXY_CREDENTIALS).toString('base64')}`,
      );
    });

    it('returns the failure string when the proxy never answers the CONNECT', async () => {
      vi.stubEnv('https_proxy', `http://127.0.0.1:${proxyPort}`);
      tunnelStatus = TUNNEL_NO_ANSWER;

      const result = await loadWebPage('https://example.com/doc', {
        timeoutMs: 50,
      });

      expect(result).toBe('Failed to fetch url: https://example.com/doc');
      expect(tlsConnectSpy).not.toHaveBeenCalled();
    });

    it('returns the failure string when the proxy refuses the tunnel', async () => {
      vi.stubEnv('https_proxy', `http://127.0.0.1:${proxyPort}`);
      tunnelStatus = 403;

      const result = await loadWebPage('https://example.com/doc');

      expect(result).toBe('Failed to fetch url: https://example.com/doc');
      expect(tlsConnectSpy).not.toHaveBeenCalled();
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
