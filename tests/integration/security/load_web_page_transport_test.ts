/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end tests for `loadWebPage`'s transport, with no mocks.
 *
 * A real origin server and a real HTTP proxy run on loopback, and the tool
 * reaches them over real sockets with the real `parse5`. The unit tests fake
 * `node:http`, so this is the only place that proves the request the tool
 * builds is one a server accepts, and that the text comes back out of it.
 *
 * The direct, address-pinned path cannot be exercised here: it connects only
 * to a globally routable address, and a test server is on loopback. The proxy
 * path shares every stage after the connection — request, response, body cap,
 * decoding and extraction — so those are covered.
 */

import {loadWebPage} from '@google/adk';
import {createServer, request, type Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const PAGE_HTML =
  '<html><head><style>.a{color:red}</style>' +
  '<script>var secret = "do not leak this";</script></head>' +
  '<body><!-- a comment --><p>Fish &amp; chips are quite tasty today</p>' +
  '<p>tiny</p></body></html>';

/** Proxy variables the tool reads, saved and restored around every test. */
const PROXY_ENV_NAMES = [
  'all_proxy',
  'ALL_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
];

/** Returns the port a listening server was given. */
function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe('loadWebPage over a real proxy', () => {
  let origin: Server;
  let proxy: Server;
  /** The absolute-form request targets the proxy received, in order. */
  let proxied: string[];
  /** The status the origin answers with. */
  let originStatus: number;
  /** The body the origin answers with. */
  let pageHtml: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    origin = createServer((req, res) => {
      res.writeHead(originStatus, {'content-type': 'text/html'});
      res.end(pageHtml);
    });
    await listen(origin);

    proxy = createServer((req, res) => {
      proxied.push(req.url ?? '');
      const target = new URL(req.url ?? '');
      const upstream = request(
        {host: '127.0.0.1', port: portOf(origin), path: target.pathname},
        (originResponse) => {
          res.writeHead(originResponse.statusCode ?? 502, {
            'content-type': originResponse.headers['content-type'] ?? '',
          });
          originResponse.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      upstream.end();
    });
    await listen(proxy);
  });

  afterAll(async () => {
    await Promise.all([close(origin), close(proxy)]);
  });

  beforeEach(() => {
    proxied = [];
    originStatus = 200;
    pageHtml = PAGE_HTML;
    for (const name of PROXY_ENV_NAMES) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    savedEnv.clear();
  });

  it('fetches and extracts a page through a proxy named by the environment', async () => {
    process.env['http_proxy'] = `http://127.0.0.1:${portOf(proxy)}`;

    const result = await loadWebPage('http://origin.example/page');

    expect(result).toBe('Fish & chips are quite tasty today');
    expect(proxied).toEqual(['http://origin.example/page']);
  });

  it('fetches through a proxy named by all_proxy', async () => {
    process.env['all_proxy'] = `http://127.0.0.1:${portOf(proxy)}`;

    const result = await loadWebPage('http://origin.example/page');

    expect(result).toBe('Fish & chips are quite tasty today');
    expect(proxied).toEqual(['http://origin.example/page']);
  });

  it('returns the failure string when the origin answers non-200', async () => {
    originStatus = 404;
    process.env['http_proxy'] = `http://127.0.0.1:${portOf(proxy)}`;

    const result = await loadWebPage('http://origin.example/page');

    expect(result).toBe('Failed to fetch url: http://origin.example/page');
    expect(proxied).toEqual(['http://origin.example/page']);
  });

  it('refuses a nesting bomb without stalling the event loop', async () => {
    // parse5's tree construction is quadratic in nesting depth, so an
    // unbounded parse of this page blocks the process for about 13 seconds.
    pageHtml = '<div>'.repeat(40_000) + 'x' + '</div>'.repeat(40_000);
    process.env['http_proxy'] = `http://127.0.0.1:${portOf(proxy)}`;
    const startedAt = Date.now();

    const result = await loadWebPage('http://origin.example/page');

    expect(result).toBe('Failed to fetch url: http://origin.example/page');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('takes the direct path when no_proxy covers the host', async () => {
    process.env['http_proxy'] = `http://127.0.0.1:${portOf(proxy)}`;
    process.env['no_proxy'] = 'origin.example';

    const result = await loadWebPage('http://origin.example/page');

    // The direct path resolves the name locally, and this one does not exist.
    expect(result).toBe('Failed to fetch url: http://origin.example/page');
    expect(proxied).toEqual([]);
  });

  it('takes the direct path for proxy: null', async () => {
    process.env['http_proxy'] = `http://127.0.0.1:${portOf(proxy)}`;

    const result = await loadWebPage('http://origin.example/page', {
      proxy: null,
    });

    expect(result).toBe('Failed to fetch url: http://origin.example/page');
    expect(proxied).toEqual([]);
  });

  it.each([
    'http://[64:ff9b::169.254.169.254]/computeMetadata/v1/',
    'http://[::169.254.169.254]/latest/meta-data/',
    'http://169.254.169.254/computeMetadata/v1/',
    'http://localhost/admin',
  ])('blocks %s before it reaches the proxy', async (url) => {
    process.env['http_proxy'] = `http://127.0.0.1:${portOf(proxy)}`;

    const result = await loadWebPage(url);

    expect(result).toBe(`Failed to fetch url: ${url}`);
    expect(proxied).toEqual([]);
  });
});
