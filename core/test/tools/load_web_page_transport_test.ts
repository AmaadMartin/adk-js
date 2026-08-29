/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createServer, type IncomingMessage, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';

import {loadWebPage} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * Drives {@link loadWebPage} against a real loopback server over real sockets,
 * with nothing mocked. A direct fetch to loopback is blocked by address
 * vetting, so the server stands in for a proxy: the target hostname is never
 * resolved, which is the documented behaviour of the proxy path.
 */
describe('loadWebPage over a real connection', () => {
  let server: Server;
  let proxy = '';
  let body = '';
  let status = 200;
  let received: IncomingMessage | undefined;

  beforeEach(async () => {
    body = '';
    status = 200;
    received = undefined;
    server = createServer((request, response) => {
      received = request;
      response.writeHead(status, {'content-type': 'text/html'});
      response.end(body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('extracts the text of a page it really fetched', async () => {
    body =
      '<html><head><style>.a{color:red}</style>' +
      '<script>var token = "do not leak this value";</script></head>' +
      '<body><h1>ignored</h1>' +
      '<p>Fish &amp; chips are quite tasty today</p>' +
      '<p>An em dash &mdash; reads as a dash</p>' +
      '<a title="a > b">This link text must survive</a>' +
      '</body></html>';

    const result = await loadWebPage('http://public.example/page?q=1', {proxy});

    expect(result).toBe(
      [
        'Fish & chips are quite tasty today',
        'An em dash — reads as a dash',
        'This link text must survive',
      ].join('\n'),
    );
    expect(result).not.toContain('token');
    expect(result).not.toContain('color:red');
  });

  it('sends the absolute-form target and the original host header', async () => {
    body = '<p>This line has enough words</p>';

    await loadWebPage('http://public.example/page?q=1', {proxy});

    expect(received?.url).toBe('http://public.example/page?q=1');
    expect(received?.headers.host).toBe('public.example');
  });

  it('returns the failure string for a real non-200 response', async () => {
    status = 302;
    body = '<p>This line has enough words</p>';

    const result = await loadWebPage('http://public.example/page', {proxy});

    expect(result).toBe('Failed to fetch url: http://public.example/page');
  });

  it('returns the failure string when the port is zero', async () => {
    const result = await loadWebPage('http://public.example:0/page', {proxy});

    expect(result).toBe('Failed to fetch url: http://public.example:0/page');
    expect(received).toBeUndefined();
  });
});
