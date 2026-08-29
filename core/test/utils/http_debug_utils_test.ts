/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  appendHttpDebugInfo,
  describeHttpExchange,
  getHttpDebugInfo,
  HttpExchange,
  isCapturingHttpDebug,
  MAX_CAPTURED_EXCHANGES,
  recordHttpExchange,
  runWithHttpDebugCapture,
} from '../../src/utils/http_debug_utils.js';

const MAX_BODY_LENGTH = 1000;
const TRUNCATION_MARKER = '... [truncated]';

/** A minimal exchange, with the fields a test does not care about filled in. */
function exchange(overrides: Partial<HttpExchange> = {}): HttpExchange {
  return {
    url: 'https://mcp.example.com/mcp',
    method: 'POST',
    statusCode: 200,
    requestHeaders: {},
    responseHeaders: {},
    responseBody: 'ok',
    ...overrides,
  };
}

describe('http debug capture', () => {
  it('reports no capture outside runWithHttpDebugCapture', () => {
    expect(isCapturingHttpDebug()).toBe(false);
  });

  it('ignores a recording made outside a capture', () => {
    expect(() => recordHttpExchange(exchange())).not.toThrow();
  });

  it('collects the exchanges recorded during the call', async () => {
    const exchanges: HttpExchange[] = [];

    const result = await runWithHttpDebugCapture(exchanges, async () => {
      expect(isCapturingHttpDebug()).toBe(true);
      recordHttpExchange(exchange({url: 'https://a.example.com/'}));
      return 'done';
    });

    expect(result).toBe('done');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].url).toBe('https://a.example.com/');
  });

  it('keeps the exchanges recorded before a rejection', async () => {
    const exchanges: HttpExchange[] = [];

    await expect(
      runWithHttpDebugCapture(exchanges, async () => {
        recordHttpExchange(exchange());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(exchanges).toHaveLength(1);
  });

  it('keeps two concurrent captures separate', async () => {
    const first: HttpExchange[] = [];
    const second: HttpExchange[] = [];

    /** Records `url` after yielding, so the two captures interleave. */
    const capture = (into: HttpExchange[], url: string) =>
      runWithHttpDebugCapture(into, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        recordHttpExchange(exchange({url}));
      });

    await Promise.all([
      capture(first, 'https://first.example.com/'),
      capture(second, 'https://second.example.com/'),
    ]);

    expect(first.map((e) => e.url)).toEqual(['https://first.example.com/']);
    expect(second.map((e) => e.url)).toEqual(['https://second.example.com/']);
  });

  it('drops the exchanges past the cap', async () => {
    const exchanges: HttpExchange[] = [];

    await runWithHttpDebugCapture(exchanges, async () => {
      for (let i = 0; i < MAX_CAPTURED_EXCHANGES + 5; i++) {
        recordHttpExchange(exchange({url: `https://example.com/${i}`}));
      }
    });

    expect(exchanges).toHaveLength(MAX_CAPTURED_EXCHANGES);
    expect(exchanges.at(-1)?.url).toBe(
      `https://example.com/${MAX_CAPTURED_EXCHANGES - 1}`,
    );
  });

  it('truncates a body over the limit', async () => {
    const exchanges: HttpExchange[] = [];
    const long = 'x'.repeat(MAX_BODY_LENGTH + 50);

    await runWithHttpDebugCapture(exchanges, async () => {
      recordHttpExchange(exchange({requestBody: long, responseBody: long}));
    });

    expect(exchanges[0].requestBody).toBe(
      'x'.repeat(MAX_BODY_LENGTH) + TRUNCATION_MARKER,
    );
    expect(exchanges[0].responseBody).toBe(
      'x'.repeat(MAX_BODY_LENGTH) + TRUNCATION_MARKER,
    );
  });

  it('leaves a body within the limit alone', async () => {
    const exchanges: HttpExchange[] = [];

    await runWithHttpDebugCapture(exchanges, async () => {
      recordHttpExchange(exchange({responseBody: 'short'}));
    });

    expect(exchanges[0].responseBody).toBe('short');
    expect(exchanges[0].requestBody).toBeUndefined();
  });

  it('redacts a credential carried in the URL', async () => {
    const exchanges: HttpExchange[] = [];

    await runWithHttpDebugCapture(exchanges, async () => {
      recordHttpExchange(
        exchange({url: 'https://mcp.example.com/mcp?access_token=abc123'}),
      );
    });

    expect(exchanges[0].url).toBe(
      'https://mcp.example.com/mcp?access_token=***',
    );
  });

  it('leaves a URL with no credential alone', async () => {
    const exchanges: HttpExchange[] = [];

    await runWithHttpDebugCapture(exchanges, async () => {
      recordHttpExchange({...exchange(), url: 'https://mcp.example.com/mcp'});
    });

    expect(exchanges[0].url).toBe('https://mcp.example.com/mcp');
  });

  it('redacts every credential-bearing header, whatever its case', async () => {
    const exchanges: HttpExchange[] = [];

    await runWithHttpDebugCapture(exchanges, async () => {
      recordHttpExchange(
        exchange({
          requestHeaders: {
            'Authorization': 'Bearer super-secret',
            'X-Api-Key': 'key-1',
            'api-key': 'key-2',
            'Proxy-Authorization': 'Basic secret',
            'x-goog-api-key': 'key-3',
            'Cookie': 'session=abc',
            'Content-Type': 'application/json',
          },
          responseHeaders: {
            'Set-Cookie': 'session=abc',
            'Content-Length': '12',
          },
        }),
      );
    });

    expect(exchanges[0].requestHeaders).toEqual({
      'Authorization': '<redacted>',
      'X-Api-Key': '<redacted>',
      'api-key': '<redacted>',
      'Proxy-Authorization': '<redacted>',
      'x-goog-api-key': '<redacted>',
      'Cookie': '<redacted>',
      'Content-Type': 'application/json',
    });
    expect(exchanges[0].responseHeaders).toEqual({
      'Set-Cookie': '<redacted>',
      'Content-Length': '12',
    });
  });
});

describe('describeHttpExchange', () => {
  /** A request description with the defaults a test does not care about. */
  function request(
    overrides: Partial<Parameters<typeof describeHttpExchange>[0]> = {},
  ) {
    return {
      url: 'https://mcp.example.com/mcp',
      method: 'POST',
      headers: new Headers({'content-type': 'application/json'}),
      ...overrides,
    };
  }

  it('describes a JSON exchange and leaves the response readable', async () => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: {'content-type': 'application/json'},
    });

    const described = await describeHttpExchange(
      request({body: '{"method":"tools/list"}'}),
      response,
    );

    expect(described).toEqual({
      url: 'https://mcp.example.com/mcp',
      method: 'POST',
      statusCode: 200,
      requestHeaders: {'content-type': 'application/json'},
      responseHeaders: {'content-type': 'application/json'},
      requestBody: '{"method":"tools/list"}',
      responseBody: '{"ok":true}',
    });
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('does not consume a Server-Sent Events response', async () => {
    const response = new Response('data: hello\n\n', {
      status: 200,
      headers: {'content-type': 'text/event-stream'},
    });

    const described = await describeHttpExchange(request(), response);

    expect(described.responseBody).toBe('<SSE stream>');
    expect(response.bodyUsed).toBe(false);
  });

  it('records a placeholder when the body cannot be read', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('stream broke'));
        },
      }),
      {status: 502},
    );

    const described = await describeHttpExchange(request(), response);

    expect(described.responseBody).toBe('<failed to read body>');
    expect(described.statusCode).toBe(502);
  });

  it('leaves out a request body that is not text', async () => {
    const described = await describeHttpExchange(
      request(),
      new Response('{}', {status: 200}),
    );

    expect(described.requestBody).toBeUndefined();
  });
});

describe('http debug info on an invocation', () => {
  it('reads back nothing when nothing was recorded', () => {
    expect(getHttpDebugInfo({})).toEqual([]);
  });

  it('reads back nothing when the key holds a non-array', () => {
    expect(getHttpDebugInfo({http_debug_info: 'not a list'})).toEqual([]);
  });

  it('appends to the existing list rather than replacing it', () => {
    const customMetadata: Record<string, unknown> = {};

    appendHttpDebugInfo(customMetadata, [exchange({url: 'https://a/'})]);
    appendHttpDebugInfo(customMetadata, [exchange({url: 'https://b/'})]);

    expect(getHttpDebugInfo(customMetadata).map((e) => e.url)).toEqual([
      'https://a/',
      'https://b/',
    ]);
  });

  it('adds no key when there is nothing to append', () => {
    const customMetadata: Record<string, unknown> = {};

    appendHttpDebugInfo(customMetadata, []);

    expect(customMetadata).toEqual({});
  });

  it('caps the accumulated list', () => {
    const customMetadata: Record<string, unknown> = {};
    const many = Array.from({length: MAX_CAPTURED_EXCHANGES}, (_unused, i) =>
      exchange({url: `https://example.com/${i}`}),
    );

    appendHttpDebugInfo(customMetadata, many);
    appendHttpDebugInfo(customMetadata, [exchange({url: 'https://over/'})]);

    expect(getHttpDebugInfo(customMetadata)).toHaveLength(
      MAX_CAPTURED_EXCHANGES,
    );
  });
});
