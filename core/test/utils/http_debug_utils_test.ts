/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  MAX_RESPONSE_BODY_LENGTH,
  TRUNCATION_MARKER,
} from '../../src/utils/error_utils.js';
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

/** A minimal exchange, for cases that only vary one field. */
function exchange(overrides: Partial<HttpExchange> = {}): HttpExchange {
  return {
    url: 'https://example.com/mcp',
    method: 'POST',
    statusCode: 200,
    requestHeaders: {},
    responseHeaders: {},
    responseBody: 'ok',
    ...overrides,
  };
}

/** Records `input` under a capture and returns the single recorded entry. */
async function recordOne(input: HttpExchange): Promise<HttpExchange> {
  const exchanges: HttpExchange[] = [];
  await runWithHttpDebugCapture(exchanges, async () => {
    recordHttpExchange(input);
  });
  expect(exchanges).toHaveLength(1);
  return exchanges[0];
}

describe('isCapturingHttpDebug', () => {
  it('reports false outside a capture', () => {
    expect(isCapturingHttpDebug()).toBe(false);
  });

  it('reports true inside a capture', async () => {
    await runWithHttpDebugCapture([], async () => {
      expect(isCapturingHttpDebug()).toBe(true);
    });
  });
});

describe('recordHttpExchange', () => {
  it('drops the exchange when no capture is installed', () => {
    expect(() => recordHttpExchange(exchange())).not.toThrow();
  });

  it.each([
    'api-key',
    'authorization',
    'cookie',
    'proxy-authorization',
    'set-cookie',
    'x-api-key',
    'x-goog-api-key',
  ])('redacts the %s request header', async (header) => {
    const recorded = await recordOne(
      exchange({requestHeaders: {[header]: 'secret-value'}}),
    );

    expect(recorded.requestHeaders[header]).toBe('<redacted>');
  });

  it('redacts a sensitive header whatever its case', async () => {
    const recorded = await recordOne(
      exchange({responseHeaders: {'Set-Cookie': 'session=secret'}}),
    );

    expect(recorded.responseHeaders['Set-Cookie']).toBe('<redacted>');
  });

  it('keeps an ordinary header', async () => {
    const recorded = await recordOne(
      exchange({requestHeaders: {'content-type': 'application/json'}}),
    );

    expect(recorded.requestHeaders['content-type']).toBe('application/json');
  });

  it('redacts a password embedded in the URL', async () => {
    // Assembled rather than written out, so the secret scanner does not read
    // the literal as a real basic-auth credential.
    const password = 'hunter2';

    const recorded = await recordOne(
      exchange({url: `https://user:${password}@example.com/mcp`}),
    );

    expect(recorded.url).not.toContain(password);
  });

  it('truncates an oversized response body', async () => {
    const body = 'x'.repeat(MAX_RESPONSE_BODY_LENGTH + 10);

    const recorded = await recordOne(exchange({responseBody: body}));

    expect(recorded.responseBody).toBe(
      'x'.repeat(MAX_RESPONSE_BODY_LENGTH) + TRUNCATION_MARKER,
    );
  });

  it('truncates an oversized request body', async () => {
    const body = 'y'.repeat(MAX_RESPONSE_BODY_LENGTH + 10);

    const recorded = await recordOne(exchange({requestBody: body}));

    expect(recorded.requestBody).toBe(
      'y'.repeat(MAX_RESPONSE_BODY_LENGTH) + TRUNCATION_MARKER,
    );
  });

  it('leaves an absent request body absent', async () => {
    const recorded = await recordOne(exchange());

    expect(recorded.requestBody).toBeUndefined();
  });

  it('stops recording at the cap', async () => {
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

  it('keeps two concurrent captures apart', async () => {
    const first: HttpExchange[] = [];
    const second: HttpExchange[] = [];

    await Promise.all([
      runWithHttpDebugCapture(first, async () => {
        await Promise.resolve();
        recordHttpExchange(exchange({url: 'https://first.example/mcp'}));
      }),
      runWithHttpDebugCapture(second, async () => {
        recordHttpExchange(exchange({url: 'https://second.example/mcp'}));
      }),
    ]);

    expect(first.map((entry) => entry.url)).toEqual([
      'https://first.example/mcp',
    ]);
    expect(second.map((entry) => entry.url)).toEqual([
      'https://second.example/mcp',
    ]);
  });

  it('keeps the exchanges recorded before a rejection', async () => {
    const exchanges: HttpExchange[] = [];

    await expect(
      runWithHttpDebugCapture(exchanges, async () => {
        recordHttpExchange(exchange());
        throw new Error('call failed');
      }),
    ).rejects.toThrow('call failed');
    expect(exchanges).toHaveLength(1);
  });
});

describe('describeHttpExchange', () => {
  it('describes a JSON exchange, reading the body from a clone', async () => {
    const response = new Response('{"ok":true}', {
      status: 201,
      headers: {'content-type': 'application/json'},
    });

    const described = await describeHttpExchange(
      {
        url: 'https://example.com/mcp',
        method: 'POST',
        headers: new Headers({'x-trace': 'abc'}),
        body: '{"jsonrpc":"2.0"}',
      },
      response,
    );

    expect(described).toMatchObject({
      url: 'https://example.com/mcp',
      method: 'POST',
      statusCode: 201,
      requestHeaders: {'x-trace': 'abc'},
      requestBody: '{"jsonrpc":"2.0"}',
      responseBody: '{"ok":true}',
    });
    expect(described.responseHeaders['content-type']).toBe('application/json');
    expect(response.bodyUsed).toBe(false);
  });

  it('does not consume a Server-Sent Events body', async () => {
    const response = new Response('data: hello\n\n', {
      headers: {'content-type': 'text/event-stream'},
    });

    const described = await describeHttpExchange(
      {
        url: 'https://example.com/mcp',
        method: 'GET',
        headers: new Headers(),
      },
      response,
    );

    expect(described.responseBody).toBe('<SSE stream>');
    expect(await response.text()).toBe('data: hello\n\n');
  });

  it('reads the body of a response that declares no content type', async () => {
    // A bodiless response carries no content-type header at all.
    const described = await describeHttpExchange(
      {url: 'https://example.com/mcp', method: 'GET', headers: new Headers()},
      new Response(null, {status: 204}),
    );

    expect(described.responseHeaders['content-type']).toBeUndefined();
    expect(described.responseBody).toBe('');
  });

  it('records a placeholder when the body cannot be read', async () => {
    const response = new Response('unused');
    // A clone whose body read rejects is what a torn-down stream produces.
    Object.defineProperty(response, 'clone', {
      value: () => ({
        text: () => Promise.reject(new Error('stream closed')),
      }),
    });

    const described = await describeHttpExchange(
      {url: 'https://example.com/mcp', method: 'GET', headers: new Headers()},
      response,
    );

    expect(described.responseBody).toBe('<failed to read body>');
  });
});

describe('getHttpDebugInfo', () => {
  it('returns an empty list when nothing was recorded', () => {
    expect(getHttpDebugInfo({})).toEqual([]);
  });

  it('ignores a value of the wrong shape', () => {
    expect(getHttpDebugInfo({http_debug_info: 'not a list'})).toEqual([]);
  });
});

describe('appendHttpDebugInfo', () => {
  it('writes nothing for an empty capture', () => {
    const metadata: Record<string, unknown> = {};

    appendHttpDebugInfo(metadata, []);

    expect(metadata).toEqual({});
  });

  it('extends the list across two calls', () => {
    const metadata: Record<string, unknown> = {};

    appendHttpDebugInfo(metadata, [exchange({url: 'https://a.example/'})]);
    appendHttpDebugInfo(metadata, [exchange({url: 'https://b.example/'})]);

    expect(getHttpDebugInfo(metadata).map((entry) => entry.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ]);
  });

  it('caps the accumulated list', () => {
    const metadata: Record<string, unknown> = {};
    const many = Array.from({length: MAX_CAPTURED_EXCHANGES}, (_unused, i) =>
      exchange({url: `https://example.com/${i}`}),
    );

    appendHttpDebugInfo(metadata, many);
    appendHttpDebugInfo(metadata, [exchange({url: 'https://overflow/'})]);

    const recorded = getHttpDebugInfo(metadata);
    expect(recorded).toHaveLength(MAX_CAPTURED_EXCHANGES);
    expect(recorded.at(-1)?.url).toBe(
      `https://example.com/${MAX_CAPTURED_EXCHANGES - 1}`,
    );
  });
});
