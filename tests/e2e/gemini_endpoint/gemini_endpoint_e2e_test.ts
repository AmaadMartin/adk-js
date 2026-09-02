/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Gemini, LlmRequest, ResourceExhaustedError} from '@google/adk';
import * as http from 'node:http';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/** Budget for the retry test, which waits out one real backoff delay. */
const RETRY_TEST_TIMEOUT_MS = 20000;

/**
 * End-to-end coverage for the Gemini endpoint options with NO mocks: a real
 * `Gemini` model, the real `@google/genai` SDK, and a real local HTTP server
 * standing in for the model endpoint. It proves that `baseUrl`, `apiVersion`
 * and `retryOptions` reach the wire, and that an HTTP 429 from the endpoint
 * arrives as a `ResourceExhaustedError`.
 */
describe('Gemini endpoint configuration (no mocks)', () => {
  interface Reply {
    status: number;
    body: string;
  }

  interface RecordedRequest {
    url: string;
    apiClientHeader: string | undefined;
  }

  const OK_REPLY: Reply = {
    status: 200,
    body: JSON.stringify({
      candidates: [{content: {role: 'model', parts: [{text: 'hello'}]}}],
    }),
  };

  function errorReply(status: number, message: string): Reply {
    return {status, body: JSON.stringify({error: {code: status, message}})};
  }

  let server: http.Server;
  let baseUrl: string;
  let requests: RecordedRequest[];
  /** Replies served in order; the last one is repeated once exhausted. */
  let replies: Reply[];

  function textRequest(): LlmRequest {
    return {
      model: 'gemini-2.5-flash',
      contents: [{role: 'user', parts: [{text: 'hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };
  }

  async function collect(model: Gemini): Promise<string[]> {
    const texts: string[] = [];
    for await (const response of model.generateContentAsync(
      textRequest(),
      false,
    )) {
      texts.push(response.content?.parts?.[0]?.text ?? '');
    }
    return texts;
  }

  beforeEach(async () => {
    requests = [];
    replies = [OK_REPLY];
    server = http.createServer((req, res) => {
      const header = req.headers['x-goog-api-client'];
      requests.push({
        url: req.url ?? '',
        apiClientHeader: Array.isArray(header) ? header.join(' ') : header,
      });
      req.resume();
      const reply = replies[0];
      if (replies.length > 1) {
        replies.shift();
      }
      res.writeHead(reply.status, {'content-type': 'application/json'});
      res.end(reply.body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the test server reported no port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('sends the configured api version and the ADK labels to the endpoint', async () => {
    const model = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      baseUrl,
      apiVersion: 'v1',
    });

    await expect(collect(model)).resolves.toEqual(['hello']);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('/v1/models/gemini-2.5-flash');
    expect(requests[0].apiClientHeader).toContain('google-adk/');
  });

  it('reports an endpoint 429 as a ResourceExhaustedError', async () => {
    replies = [errorReply(429, 'no quota')];
    const model = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      baseUrl,
    });

    const error = await collect(model).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceExhaustedError);
    if (!(error instanceof ResourceExhaustedError)) {
      expect.fail('expected a ResourceExhaustedError');
    }
    expect(error.status).toBe(429);
    expect(error.message).toContain('#error-code-429-resource_exhausted');
    expect(requests).toHaveLength(1);
  });

  it('leaves any other endpoint error alone', async () => {
    replies = [errorReply(400, 'bad request')];
    const model = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      baseUrl,
    });

    const error = await collect(model).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ResourceExhaustedError);
    expect(error).toBeInstanceOf(Error);
    expect(requests).toHaveLength(1);
  });

  it(
    'retries the endpoint as many times as configured',
    async () => {
      replies = [errorReply(503, 'unavailable'), OK_REPLY];
      const model = new Gemini({
        model: 'gemini-2.5-flash',
        apiKey: 'test-key',
        baseUrl,
        retryOptions: {attempts: 2},
      });

      await expect(collect(model)).resolves.toEqual(['hello']);
      expect(requests).toHaveLength(2);
    },
    RETRY_TEST_TIMEOUT_MS,
  );
});
