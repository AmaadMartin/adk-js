/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  AdkApiClient,
  AdkApiServer,
  type AdkApiClientConfig,
  type AdkApiServerOptions,
  type RunAgentRequest,
} from '../src/index.js';

const BACKEND_URL = 'http://localhost:3000';

/**
 * Mirrors a consumer helper that names the request type in its signature
 * instead of inlining an object literal at the call site.
 */
function buildRequest(text: string): RunAgentRequest {
  return {
    appName: 'app1',
    userId: 'user1',
    sessionId: 'session1',
    newMessage: text,
    streaming: false,
    stateDelta: {},
  };
}

describe('package entry point', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports AdkApiClientConfig so a client can be built from a typed config', async () => {
    const config: AdkApiClientConfig = {backendUrl: BACKEND_URL};
    fetchMock.mockResolvedValue({ok: true, json: async () => ['app1']});

    const client = new AdkApiClient(config);
    const apps = await client.listApps();

    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/list-apps`,
      undefined,
    );
    expect(apps).toEqual(['app1']);
  });

  it('exports RunAgentRequest so a request can be built in a typed helper', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: {getReader: () => ({read: async () => ({done: true})})},
    });

    await new AdkApiClient({backendUrl: BACKEND_URL})
      .runAsync(buildRequest('hello'))
      .next();

    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/run_sse`,
      expect.objectContaining({
        body: expect.stringContaining('"parts":[{"text":"hello"}]'),
      }),
    );
  });

  it('exports AdkApiServerOptions so a server can be built from typed options', () => {
    const options: AdkApiServerOptions = {host: '127.0.0.1', port: 8000};

    expect(new AdkApiServer(options).url).toBe('http://127.0.0.1:8000');
  });
});
