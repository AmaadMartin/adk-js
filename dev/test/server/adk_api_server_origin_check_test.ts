/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '@google/adk';
import * as http from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

const TEST_AGENT = new LlmAgent({name: 'testAgent', description: 'test agent'});

const AGENT_LOADER = {
  listAgents: () => Promise.resolve(['testApp']),
  getAgentFile: () =>
    Promise.resolve({
      load: () => Promise.resolve(TEST_AGENT),
      async [Symbol.asyncDispose](): Promise<void> {
        return;
      },
    }),
} as unknown as AgentLoader;

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Issues a request with `node:http` rather than `fetch`, because undici
 * silently drops a caller-supplied `Host` header.
 */
function request(
  port: number,
  path: string,
  options: {method?: string; headers?: http.OutgoingHttpHeaders} = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({status: res.statusCode ?? 0, headers: res.headers, body}),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Result of a raw WebSocket handshake attempt. */
interface UpgradeResult {
  status?: number;
  closed: boolean;
}

function upgrade(
  port: number,
  headers: http.OutgoingHttpHeaders,
): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'localhost',
      port,
      path: '/ws',
      headers: {Connection: 'Upgrade', Upgrade: 'websocket', ...headers},
    });
    req.on('response', (res) => {
      res.resume();
      resolve({status: res.statusCode, closed: true});
    });
    // An accepted-but-unhandled upgrade is closed by the guard, which surfaces
    // as a socket close (or reset) without any HTTP response.
    req.on('close', () => resolve({closed: true}));
    req.on('error', (error: Error & {code?: string}) => {
      if (error.code === 'ECONNRESET') {
        resolve({closed: true});
        return;
      }
      reject(error);
    });
    req.end();
  });
}

describe('AdkApiServer origin and host validation', () => {
  let server: AdkApiServer;

  async function startServer(
    options: {allowOrigins?: string; trustProxyHeaders?: boolean} = {},
  ): Promise<number> {
    server = new AdkApiServer({agentLoader: AGENT_LOADER, ...options});
    await server.start();
    return Number(new URL(server.url).port);
  }

  afterEach(async () => {
    await server.stop();
  });

  it('rejects a state-changing request from a foreign origin', async () => {
    const port = await startServer();

    const response = await request(port, '/apps/testApp/users/u/sessions', {
      method: 'POST',
      headers: {origin: 'http://evil.com'},
    });

    expect(response.status).toBe(403);
    expect(response.body).toBe('Forbidden: origin not allowed');
  });

  it('allows a state-changing request without an origin', async () => {
    const port = await startServer();

    const response = await request(port, '/apps/testApp/users/u/sessions', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
  });

  it('allows a safe request from a foreign origin', async () => {
    const port = await startServer();

    const response = await request(port, '/list-apps', {
      headers: {origin: 'http://evil.com'},
    });

    expect(response.status).toBe(200);
  });

  it('allows a state-changing request from its own origin', async () => {
    const port = await startServer();

    const response = await request(port, '/apps/testApp/users/u/sessions', {
      method: 'POST',
      headers: {origin: `http://localhost:${port}`},
    });

    expect(response.status).toBe(200);
  });

  it('rejects a request whose Host is outside the allowlist', async () => {
    const port = await startServer();

    const response = await request(port, '/list-apps', {
      headers: {host: 'evil.com:1234'},
    });

    expect(response.status).toBe(403);
    expect(response.body).toBe('Forbidden: host not allowed');
  });

  it('accepts every loopback spelling of its own Host', async () => {
    const port = await startServer();

    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const response = await request(port, '/list-apps', {headers: {host}});

      expect(response.status).toBe(200);
    }
  });

  it('lets a configured origin through and echoes the CORS header', async () => {
    const port = await startServer({allowOrigins: 'http://evil.com'});

    const response = await request(port, '/apps/testApp/users/u/sessions', {
      method: 'POST',
      headers: {origin: 'http://evil.com'},
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://evil.com',
    );
  });

  it('ignores X-Forwarded-Host by default', async () => {
    const port = await startServer();

    const response = await request(port, '/list-apps', {
      headers: {host: 'evil.com:1234', 'x-forwarded-host': `localhost:${port}`},
    });

    expect(response.status).toBe(403);
  });

  it('stops enforcing the Host allowlist when proxy headers are trusted', async () => {
    const port = await startServer({trustProxyHeaders: true});

    const response = await request(port, '/list-apps', {
      headers: {host: 'evil.com:1234', 'x-forwarded-host': `localhost:${port}`},
    });

    expect(response.status).toBe(200);
  });

  it('rejects a WebSocket upgrade from a foreign origin', async () => {
    const port = await startServer();

    const result = await upgrade(port, {origin: 'http://evil.com'});

    expect(result.status).toBe(403);
  });

  it('closes an allowed WebSocket upgrade that no handler claims', async () => {
    const port = await startServer();

    const result = await upgrade(port, {origin: `http://localhost:${port}`});

    expect(result.status).toBeUndefined();
    expect(result.closed).toBe(true);
  });
});
