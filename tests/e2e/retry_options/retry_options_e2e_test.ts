/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApigeeLlm, LlmRequest} from '@google/adk';
import * as http from 'http';
import {AddressInfo} from 'net';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * End-to-end coverage for `retryOptions` with NO mocks: a real ADK model, the
 * real `@google/genai` SDK, and a real local HTTP server. `ApigeeLlm` is used
 * because it lets us point the underlying client's `baseUrl` at the local
 * server (via `proxyUrl`). The server always answers `503 Service Unavailable`
 * (a retriable status), so the SDK retries exactly `attempts` times before
 * giving up, which lets us assert the configured retry count actually reaches
 * the wire.
 */
describe('E2e retryOptions (no mocks)', () => {
  let server: http.Server;
  let requestCount: number;
  let proxyUrl: string;

  beforeEach(async () => {
    requestCount = 0;
    server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(503, {'Content-Type': 'text/plain'});
      res.end('Service Unavailable');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const {port} = server.address() as AddressInfo;
    proxyUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function makeRequest(): LlmRequest {
    return {
      contents: [{parts: [{text: 'Hello'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    } as LlmRequest;
  }

  it('retries the underlying SDK call exactly `attempts` times on 503', async () => {
    const attempts = 3;
    const llm = new ApigeeLlm({
      model: 'apigee/gemini/gemini-2.5-flash',
      proxyUrl,
      apiKey: 'fake-key-for-local-server',
      retryOptions: {attempts},
    });

    await expect(
      llm.generateContentAsync(makeRequest()).next(),
    ).rejects.toThrow();

    // `attempts` total requests: 1 initial + (attempts - 1) retries.
    expect(requestCount).toBe(attempts);
  }, 20000);

  it('does not retry when retryOptions is omitted (single request)', async () => {
    const llm = new ApigeeLlm({
      model: 'apigee/gemini/gemini-2.5-flash',
      proxyUrl,
      apiKey: 'fake-key-for-local-server',
    });

    await expect(
      llm.generateContentAsync(makeRequest()).next(),
    ).rejects.toThrow();

    expect(requestCount).toBe(1);
  }, 20000);
});
