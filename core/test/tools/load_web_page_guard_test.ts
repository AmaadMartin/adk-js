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
 * Drives {@link loadWebPage} against a real server over real sockets, with
 * nothing mocked. The server listens on loopback, which the tool refuses to
 * reach, so these tests assert the refusal. The server is the witness: it
 * answers anything that arrives, so a request reaching it means the guard let
 * a connection through.
 */
describe('loadWebPage against a real server', () => {
  let server: Server;
  let port = 0;
  let received: IncomingMessage | undefined;

  beforeEach(async () => {
    received = undefined;
    server = createServer((request, response) => {
      received = request;
      response.writeHead(200, {'content-type': 'text/html'});
      response.end('<p>This body must never be read</p>');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('opens no socket to a loopback address', async () => {
    const url = `http://127.0.0.1:${port}/page?q=1`;

    const result = await loadWebPage(url);

    expect(result).toBe(`Failed to fetch url: ${url}`);
    expect(received).toBeUndefined();
  });

  it('opens no socket to the loopback hostname', async () => {
    const url = `http://localhost:${port}/page`;

    const result = await loadWebPage(url);

    expect(result).toBe(`Failed to fetch url: ${url}`);
    expect(received).toBeUndefined();
  });
});
