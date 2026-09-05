/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompletionArgs,
  FetchLiteLlmClient,
  ModelResponseStream,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const API_BASE = 'https://proxy.example.com/v1';

const ARGS: CompletionArgs = {
  model: 'openai/gpt-4o',
  messages: [{role: 'user', content: 'hi'}],
};

/** The options of the single `fetch` call the client made. */
type FetchOptions = NonNullable<Parameters<typeof fetch>[1]>;

/** Reads the url and the options of the single `fetch` call. */
function fetchCall(): {url: string; options: FetchOptions} {
  const mock = vi.mocked(fetch);
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, options] = mock.mock.calls[0];
  if (!options) {
    return expect.fail('fetch was called without options');
  }
  return {url: String(url), options};
}

/** Reads the JSON body of the single `fetch` call the client made. */
function requestBody(): Record<string, unknown> {
  return JSON.parse(String(fetchCall().options.body)) as Record<
    string,
    unknown
  >;
}

/**
 * Reads the headers of the single `fetch` call, keyed by lowercase name.
 *
 * Header names are case-insensitive, and `Headers` normalizes them.
 */
function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(fetchCall().options.headers).forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

/** Builds a response whose body closes once every chunk is written. */
function closedStreamResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {status: 200});
}

/** Builds a response whose body stays open, so cancellation is observable. */
function openStreamResponse(chunks: string[], onCancel: () => void): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[index++]));
        return undefined;
      }
      // Never resolves: the consumer is expected to stop reading and cancel.
      return new Promise<void>(() => {});
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(stream, {status: 200});
}

/** Drains an async iterable into an array. */
async function collect(
  stream: AsyncIterable<ModelResponseStream>,
): Promise<ModelResponseStream[]> {
  const chunks: ModelResponseStream[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('FetchLiteLlmClient', () => {
  beforeEach(() => {
    delete process.env['LITELLM_API_BASE'];
    delete process.env['LITELLM_API_KEY'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['LITELLM_API_BASE'];
    delete process.env['LITELLM_API_KEY'];
  });

  describe('construction', () => {
    it('requires a base url', () => {
      expect(() => new FetchLiteLlmClient()).toThrow(
        'A base URL is required: pass `apiBase` or set the LITELLM_API_BASE environment variable.',
      );
    });

    it('reads the base url from the environment', async () => {
      process.env['LITELLM_API_BASE'] = API_BASE;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
      await new FetchLiteLlmClient().completion(ARGS);
      expect(fetchCall().url).toBe(
        'https://proxy.example.com/v1/chat/completions',
      );
    });

    it('ignores the environment in a browser', () => {
      process.env['LITELLM_API_BASE'] = API_BASE;
      vi.stubGlobal('window', {});
      expect(() => new FetchLiteLlmClient()).toThrow('A base URL is required');
    });

    it('reads the api key from the environment', async () => {
      process.env['LITELLM_API_KEY'] = 'env-key';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
      await new FetchLiteLlmClient({apiBase: API_BASE}).completion(ARGS);
      expect(requestHeaders()['authorization']).toBe('Bearer env-key');
    });

    it.each([
      [API_BASE, 'https://proxy.example.com/v1/chat/completions'],
      [`${API_BASE}//`, 'https://proxy.example.com/v1/chat/completions'],
      [
        `${API_BASE}/chat/completions`,
        'https://proxy.example.com/v1/chat/completions',
      ],
    ])('builds the url from %s', async (apiBase, expected) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
      await new FetchLiteLlmClient({apiBase}).completion(ARGS);
      expect(fetchCall().url).toBe(expected);
    });
  });

  describe('completion', () => {
    it('posts the request and returns the parsed response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(Response.json({model: 'gpt-4o'})),
      );
      const response = await new FetchLiteLlmClient({
        apiBase: API_BASE,
        apiKey: 'secret',
        headers: {'X-Team': 'adk'},
      }).completion(ARGS);

      expect(response).toEqual({model: 'gpt-4o'});
      expect(fetchCall().options.method).toBe('POST');
      expect(requestBody()).toEqual(ARGS);
      expect(requestHeaders()).toEqual({
        'x-team': 'adk',
        'content-type': 'application/json',
        'authorization': 'Bearer secret',
      });
    });

    it('omits the authorization header when there is no key', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
      await new FetchLiteLlmClient({apiBase: API_BASE}).completion(ARGS);
      expect(requestHeaders()['authorization']).toBeUndefined();
    });

    it('sends extra headers as http headers, not as body fields', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
      await new FetchLiteLlmClient({
        apiBase: API_BASE,
        headers: {'X-Team': 'adk'},
      }).completion({...ARGS, extra_headers: {'X-Trace': 'abc'}});

      expect(requestHeaders()).toMatchObject({
        'x-team': 'adk',
        'x-trace': 'abc',
      });
      expect(requestBody()['extra_headers']).toBeUndefined();
    });

    it('keeps the client headers beneath the ones it sets itself', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
      await new FetchLiteLlmClient({
        apiBase: API_BASE,
        apiKey: 'secret',
        headers: {
          'Content-Type': 'text/plain',
          'Authorization': 'Bearer other',
        },
      }).completion(ARGS);

      expect(requestHeaders()).toMatchObject({
        'content-type': 'application/json',
        'authorization': 'Bearer secret',
      });
    });

    it('merges extra body fields into the request body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
      await new FetchLiteLlmClient({apiBase: API_BASE}).completion({
        ...ARGS,
        extra_body: {custom: 1},
      });

      expect(requestBody()).toEqual({...ARGS, custom: 1});
    });

    it('forwards the abort signal', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
      const controller = new AbortController();
      await new FetchLiteLlmClient({apiBase: API_BASE}).completion(
        ARGS,
        controller.signal,
      );
      expect(fetchCall().options.signal).toBe(controller.signal);
    });

    it('reports the model, the status and the body on an error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('no such model', {status: 404})),
      );
      await expect(
        new FetchLiteLlmClient({apiBase: API_BASE}).completion(ARGS),
      ).rejects.toThrow(
        'LiteLlm request to model openai/gpt-4o failed with status 404: no such model',
      );
    });

    it('truncates a long error body', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response('x'.repeat(4096), {status: 500})),
      );
      await expect(
        new FetchLiteLlmClient({apiBase: API_BASE}).completion(ARGS),
      ).rejects.toThrow(`status 500: ${'x'.repeat(2048)}`);
    });
  });

  describe('streamCompletion', () => {
    it('parses server-sent event frames', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            closedStreamResponse([
              'data: {"model": "a"}\n\ndata: {"mo',
              'del": "b"}\n\n',
              'data: [DONE]\n\n',
            ]),
          ),
      );
      const stream = await new FetchLiteLlmClient({
        apiBase: API_BASE,
      }).streamCompletion(ARGS);

      expect(await collect(stream)).toEqual([{model: 'a'}, {model: 'b'}]);
      expect(requestBody()).toEqual(ARGS);
    });

    it('accepts carriage returns and ignores non-data lines', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            closedStreamResponse([
              ': keep-alive\r\n\r\n',
              'event: message\r\ndata: {"model": "a"}\r\n\r\n',
              '\r\n\r\n',
            ]),
          ),
      );
      const stream = await new FetchLiteLlmClient({
        apiBase: API_BASE,
      }).streamCompletion(ARGS);
      expect(await collect(stream)).toEqual([{model: 'a'}]);
    });

    it('reads a trailing frame that has no separator after it', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(closedStreamResponse(['data: {"model": "a"}'])),
      );
      const stream = await new FetchLiteLlmClient({
        apiBase: API_BASE,
      }).streamCompletion(ARGS);
      expect(await collect(stream)).toEqual([{model: 'a'}]);
    });

    it('stops at a trailing [DONE] frame', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(closedStreamResponse(['data: [DONE]'])),
      );
      const stream = await new FetchLiteLlmClient({
        apiBase: API_BASE,
      }).streamCompletion(ARGS);
      expect(await collect(stream)).toEqual([]);
    });

    it('cancels the body when the stream ends early', async () => {
      let cancelled = false;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          openStreamResponse(
            ['data: {"model": "a"}\n\n', 'data: [DONE]\n\n'],
            () => {
              cancelled = true;
            },
          ),
        ),
      );
      const stream = await new FetchLiteLlmClient({
        apiBase: API_BASE,
      }).streamCompletion(ARGS);

      expect(await collect(stream)).toEqual([{model: 'a'}]);
      expect(cancelled).toBe(true);
    });

    it('cancels the body when a frame fails to parse', async () => {
      let cancelled = false;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          openStreamResponse(['data: {oops\n\n'], () => {
            cancelled = true;
          }),
        ),
      );
      const stream = await new FetchLiteLlmClient({
        apiBase: API_BASE,
      }).streamCompletion(ARGS);

      await expect(collect(stream)).rejects.toThrow(SyntaxError);
      expect(cancelled).toBe(true);
    });

    it('rejects a streaming response with no body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, {status: 204})),
      );
      await expect(
        new FetchLiteLlmClient({apiBase: API_BASE}).streamCompletion(ARGS),
      ).rejects.toThrow(
        'LiteLlm streaming request to model openai/gpt-4o returned no body.',
      );
    });

    it('reports an error status before it reads the stream', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('boom', {status: 500})),
      );
      await expect(
        new FetchLiteLlmClient({apiBase: API_BASE}).streamCompletion(ARGS),
      ).rejects.toThrow('failed with status 500: boom');
    });
  });
});
