/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `src/google/adk/tools/_gda_stream_util.py` and the
 * pipeline cases in
 * `tests/unittests/integrations/bigquery/test_bigquery_data_insights_tool.py`
 * (branch `main`).
 */

import {describe, expect, it, vi} from 'vitest';
import {
  getGdaHeaders,
  postGdaStream,
  readGdaStream,
} from '../../../src/tools/bigquery/gda_stream_util.js';

/** The options argument of the global `fetch`. */
type FetchOptions = Parameters<typeof fetch>[1];

const {getAccessToken} = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => ({token: 'test-token' as string | null})),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return {getAccessToken};
    }
  },
}));

/** Streams `lines` the way the API frames its JSON array. */
function stream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

describe('readGdaStream', () => {
  it('reassembles the array the API frames across lines', async () => {
    const messages = await readGdaStream(
      stream(['[{', '"systemMessage": {"text": {"parts": ["hello"]}}', '}]']),
      50,
    );

    expect(messages).toEqual([{text: {parts: ['hello']}}]);
  });

  it('skips a blank line and a lone comma between objects', async () => {
    const messages = await readGdaStream(
      stream([
        '[{',
        '"systemMessage": {"a": 1}',
        '}]',
        '',
        ',',
        '[{',
        '"systemMessage": {"b": 2}',
        '}]',
      ]),
      50,
    );

    expect(messages).toEqual([{a: 1}, {b: 2}]);
  });

  it('keeps a message that is not an object as it arrived', async () => {
    const messages = await readGdaStream(stream(['"a plain string"']), 50);

    expect(messages).toEqual(['a plain string']);
  });

  it('keeps a message that carries no system message', async () => {
    const messages = await readGdaStream(stream(['{"error": "boom"}']), 50);

    expect(messages).toEqual([{error: 'boom'}]);
  });

  it('reads a body whose last line has no newline', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"systemMessage": {"a": 1}}'));
        controller.close();
      },
    });

    await expect(readGdaStream(body, 50)).resolves.toEqual([{a: 1}]);
  });

  it('joins a line the transport split across two chunks', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"systemMessage": {"a"'));
        controller.enqueue(encoder.encode(': 1}}\n'));
        controller.close();
      },
    });

    await expect(readGdaStream(body, 50)).resolves.toEqual([{a: 1}]);
  });

  it('formats retrieved rows against the result schema', async () => {
    const message = {
      systemMessage: {
        data: {
          result: {
            schema: {fields: [{name: 'city'}, {name: 'total'}]},
            data: [
              {city: 'Paris', total: 3},
              {city: 'Rome', total: 5},
            ],
          },
        },
      },
    };

    const messages = await readGdaStream(stream([JSON.stringify(message)]), 50);

    expect(messages).toEqual([
      {
        'Data Retrieved': {
          headers: ['city', 'total'],
          rows: [
            ['Paris', 3],
            ['Rome', 5],
          ],
          summary: 'Showing all 2 rows.',
        },
      },
    ]);
  });

  it('falls back to the first row for the headers', async () => {
    const message = {
      systemMessage: {data: {result: {data: [{city: 'Paris'}]}}},
    };

    const messages = await readGdaStream(stream([JSON.stringify(message)]), 50);

    expect(messages).toEqual([
      {
        'Data Retrieved': {
          headers: ['city'],
          rows: [['Paris']],
          summary: 'Showing all 1 rows.',
        },
      },
    ]);
  });

  it('reports an empty result without headers', async () => {
    const message = {systemMessage: {data: {result: {data: []}}}};

    const messages = await readGdaStream(stream([JSON.stringify(message)]), 50);

    expect(messages).toEqual([
      {
        'Data Retrieved': {
          headers: [],
          rows: [],
          summary: 'Showing all 0 rows.',
        },
      },
    ]);
  });

  it('caps the rows it keeps and says how many it dropped', async () => {
    const message = {
      systemMessage: {
        data: {
          result: {
            schema: {fields: [{name: 'n'}]},
            data: [{n: 1}, {n: 2}, {n: 3}],
          },
        },
      },
    };

    const messages = await readGdaStream(stream([JSON.stringify(message)]), 2);

    expect(messages).toEqual([
      {
        'Data Retrieved': {
          headers: ['n'],
          rows: [[1], [2]],
          summary: 'Showing the first 2 of 3 total rows.',
        },
      },
    ]);
  });

  it('replaces an earlier result with a placeholder', async () => {
    const message = (value: number) => ({
      systemMessage: {
        data: {
          result: {schema: {fields: [{name: 'n'}]}, data: [{n: value}]},
        },
      },
    });

    const messages = await readGdaStream(
      stream([JSON.stringify(message(1)), JSON.stringify(message(2))]),
      50,
    );

    expect(messages[0]).toEqual({
      'Data Retrieved': 'Intermediate result omitted',
    });
    expect(messages[1]).toMatchObject({
      'Data Retrieved': {rows: [[2]]},
    });
  });

  it('drops a row the API sent as something other than an object', async () => {
    const message = {
      systemMessage: {
        data: {
          result: {
            schema: {fields: [{name: 'n'}]},
            // A list and a string are both dropped, matching adk-python's
            // `isinstance(r, dict)` check.
            data: [{n: 1}, 'junk', [2]],
          },
        },
      },
    };

    const messages = await readGdaStream(stream([JSON.stringify(message)]), 50);

    expect(messages).toEqual([
      {
        'Data Retrieved': {
          headers: ['n'],
          rows: [[1]],
          summary: 'Showing all 3 rows.',
        },
      },
    ]);
  });

  it.each([
    {id: 'no data key', value: {systemMessage: {other: 1}}},
    {id: 'data is not an object', value: {systemMessage: {data: 'x'}}},
    {
      id: 'result is not an object',
      value: {systemMessage: {data: {result: 1}}},
    },
    {
      id: 'result data is not a list',
      value: {systemMessage: {data: {result: {data: 'x'}}}},
    },
  ])('reads $id as an ordinary system message', async ({value}) => {
    const messages = await readGdaStream(stream([JSON.stringify(value)]), 50);

    expect(messages).toEqual([value.systemMessage]);
  });
});

describe('postGdaStream', () => {
  /** A response whose body streams `lines`. */
  function jsonStreamResponse(lines: string[]): Response {
    return new Response(stream(lines), {status: 200});
  }

  it('posts the payload and returns the messages', async () => {
    const calls: Array<[string, FetchOptions]> = [];
    const fetchStub = async (
      url: string | URL | Request,
      init?: FetchOptions,
    ): Promise<Response> => {
      calls.push([String(url), init]);
      return jsonStreamResponse(['{"systemMessage": {"a": 1}}']);
    };

    const messages = await withFetch(fetchStub, () =>
      postGdaStream(
        'https://example.test/v1:chat',
        {messages: []},
        {'Content-Type': 'application/json'},
        50,
      ),
    );

    expect(messages).toEqual([{a: 1}]);
    expect(calls[0][0]).toBe('https://example.test/v1:chat');
    expect(calls[0][1]?.method).toBe('POST');
    expect(calls[0][1]?.body).toBe('{"messages":[]}');
  });

  it('throws with the body when the API refuses the request', async () => {
    const fetchStub = async (): Promise<Response> =>
      new Response('quota exceeded', {status: 429});

    await expect(
      withFetch(fetchStub, () =>
        postGdaStream('https://example.test', {}, {}, 50),
      ),
    ).rejects.toThrow(
      'Conversational Analytics API returned 429: quota exceeded',
    );
  });

  it('throws when the API answers without a body', async () => {
    const fetchStub = async (): Promise<Response> =>
      new Response(null, {status: 204});

    await expect(
      withFetch(fetchStub, () =>
        postGdaStream('https://example.test', {}, {}, 50),
      ),
    ).rejects.toThrow(
      'Conversational Analytics API returned no response body.',
    );
  });
});

/** Runs `body` with `fetch` replaced, restoring the real one afterwards. */
async function withFetch<T>(
  stub: typeof fetch,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe('getGdaHeaders', () => {
  it('asks the caller credentials for the bearer token', async () => {
    const headers = await getGdaHeaders('GOOGLE_ADK', {
      keyFilename: '/tmp/key.json',
      scopes: ['scope-a'],
    });

    expect(headers).toEqual({
      'Authorization': 'Bearer test-token',
      'Content-Type': 'application/json',
      'X-Goog-API-Client': 'GOOGLE_ADK',
    });
  });

  it('refuses to call the API without an access token', async () => {
    getAccessToken.mockResolvedValueOnce({token: null});

    await expect(getGdaHeaders('GOOGLE_ADK')).rejects.toThrow(
      'Could not obtain an access token for the Conversational Analytics API.',
    );
  });
});
