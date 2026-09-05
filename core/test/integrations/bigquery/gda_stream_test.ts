/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the Conversational Analytics chat stream `ask_data_insights` reads:
 * the host it picks, the accumulator that turns a streamed JSON array back
 * into messages, and the `fetch`-backed transport.
 *
 * Ported from the part of adk-python@main
 * `tests/unittests/tools/test__gda_stream_util.py` that covers `get_stream`
 * and `get_gda_endpoint`. The `get_gda_session` mTLS cases are not ported:
 * they assert `configure_mtls_channel()` on a `requests` session, and this
 * port has no mTLS branch.
 */

import {
  GdaStream,
  createGdaStream,
  extractDataResult,
  formatDataRetrieved,
  gdaHeaders,
  resolveGdaEndpoint,
  streamChat,
} from '@google/adk/integrations/bigquery/gda_stream.js';
import {OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';

/** A transport that replays `lines`, so the real accumulator runs over them. */
function replay(lines: string[]): GdaStream {
  return async function* stream() {
    for (const line of lines) {
      yield line;
    }
  };
}

/** Streams `lines` through the real accumulator. */
function chatOver(lines: string[], maxRows = 10): Promise<unknown[]> {
  return streamChat(replay(lines), 'url', {}, {}, maxRows);
}

/** A `fetch` answer whose body streams `chunks`. */
function streamingResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {status});
}

/** Reads a transport's stream to the end. */
async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) {
    lines.push(line);
  }
  return lines;
}

describe('resolveGdaEndpoint', () => {
  it('uses the global host when no location is named', () => {
    expect(resolveGdaEndpoint()).toBe(
      'https://geminidataanalytics.googleapis.com',
    );
    expect(resolveGdaEndpoint('  GLOBAL ')).toBe(
      'https://geminidataanalytics.googleapis.com',
    );
  });

  it('uses a regional endpoint product host for eu and us', () => {
    expect(resolveGdaEndpoint('EU')).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com',
    );
    expect(resolveGdaEndpoint('us')).toBe(
      'https://geminidataanalytics.us.rep.googleapis.com',
    );
  });

  it('uses a regional host for any other location', () => {
    expect(resolveGdaEndpoint('europe-west1')).toBe(
      'https://geminidataanalytics-europe-west1.googleapis.com',
    );
  });
});

describe('gdaHeaders', () => {
  it('names ADK as the calling client', () => {
    expect(gdaHeaders()).toEqual({
      'Content-Type': 'application/json',
      'X-Goog-API-Client': 'GOOGLE_ADK',
    });
  });
});

describe('extractDataResult', () => {
  it('finds a result carrying rows', () => {
    const result = {data: [{a: 1}]};
    expect(extractDataResult({systemMessage: {data: {result}}})).toEqual(
      result,
    );
  });

  it.each([
    {id: 'no-system-message', message: {other: 1}},
    {id: 'system-message-not-a-record', message: {systemMessage: 'text'}},
    {id: 'no-data', message: {systemMessage: {text: 'hi'}}},
    {id: 'data-not-a-record', message: {systemMessage: {data: 'x'}}},
    {id: 'no-result', message: {systemMessage: {data: {}}}},
    {id: 'result-not-a-record', message: {systemMessage: {data: {result: 1}}}},
    {
      id: 'result-without-rows',
      message: {systemMessage: {data: {result: {schema: {}}}}},
    },
  ])('ignores a message with $id', ({message}) => {
    expect(extractDataResult(message)).toBeUndefined();
  });
});

describe('formatDataRetrieved', () => {
  it('reads the column names from the schema', () => {
    expect(
      formatDataRetrieved(
        {schema: {fields: [{name: 'a'}, {noName: true}]}, data: [{a: 1}]},
        10,
      ),
    ).toEqual({
      'Data Retrieved': {
        headers: ['a'],
        rows: [[1]],
        summary: 'Showing all 1 rows.',
      },
    });
  });

  it('falls back to the keys of the first row', () => {
    expect(formatDataRetrieved({data: [{b: 2}]}, 10)).toEqual({
      'Data Retrieved': {
        headers: ['b'],
        rows: [[2]],
        summary: 'Showing all 1 rows.',
      },
    });
  });

  it('reports no headers for a result with no rows', () => {
    expect(formatDataRetrieved({}, 10)).toEqual({
      'Data Retrieved': {headers: [], rows: [], summary: 'Showing all 0 rows.'},
    });
  });

  it('drops a row that is not a record', () => {
    expect(
      formatDataRetrieved({data: [{a: 1}, 'not a row'], schema: {}}, 10),
    ).toEqual({
      'Data Retrieved': {
        headers: ['a'],
        rows: [[1]],
        summary: 'Showing all 2 rows.',
      },
    });
  });

  it('says how many rows it kept when it trimmed the result', () => {
    expect(formatDataRetrieved({data: [{a: 1}, {a: 2}, {a: 3}]}, 2)).toEqual({
      'Data Retrieved': {
        headers: ['a'],
        rows: [[1], [2]],
        summary: 'Showing the first 2 of 3 total rows.',
      },
    });
  });
});

describe('streamChat', () => {
  it('reassembles a message split across the array framing', async () => {
    expect(
      await chatOver(['[{', '"systemMessage":', '{"text":"hi"}', '}]']),
    ).toEqual([{text: 'hi'}]);
  });

  it('skips a blank line and the array separator', async () => {
    expect(
      await chatOver(['', '{"systemMessage":{"text":"hi"}}', ',', '']),
    ).toEqual([{text: 'hi'}]);
  });

  it('passes a message that is not a record through unchanged', async () => {
    expect(await chatOver(['"just a string"'])).toEqual(['just a string']);
  });

  it('passes a message with no system message through unchanged', async () => {
    expect(await chatOver(['{"other":1}'])).toEqual([{other: 1}]);
  });

  it('keeps only the newest result, dropping the rows of the older one', async () => {
    const data = (value: number) =>
      JSON.stringify({systemMessage: {data: {result: {data: [{a: value}]}}}});

    expect(await chatOver([data(1), data(2)])).toEqual([
      {'Data Retrieved': 'Intermediate result omitted'},
      {
        'Data Retrieved': {
          headers: ['a'],
          rows: [[2]],
          summary: 'Showing all 1 rows.',
        },
      },
    ]);
  });
});

describe('createGdaStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts with the credential headers and the caller headers', async () => {
    const credentials = new OAuth2Client();
    vi.spyOn(credentials, 'getRequestHeaders').mockResolvedValue(
      new Headers({authorization: 'Bearer token'}),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(streamingResponse(['{"a":1}']));

    const lines = await collect(
      createGdaStream(credentials)(
        'https://gda.example/v1/chat',
        {a: 1},
        {
          'X-Goog-API-Client': 'GOOGLE_ADK',
        },
      ),
    );

    expect(lines).toEqual(['{"a":1}']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gda.example/v1/chat');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    const headers = init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('X-Goog-API-Client')).toBe('GOOGLE_ADK');
  });

  it('posts unauthenticated when there is no credential', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(streamingResponse([]));

    await collect(createGdaStream()('url', {}, {}));

    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('authorization')).toBeNull();
  });

  it('splits a streamed body into lines, dropping the terminators', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamingResponse(['[{\r\n"a":', '1}]\n{"b":2}']),
    );

    expect(await collect(createGdaStream()('url', {}, {}))).toEqual([
      '[{',
      '"a":1}]',
      '{"b":2}',
    ]);
  });

  it('reports the status when the API refused the stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('quota exceeded', {status: 429}),
    );

    await expect(collect(createGdaStream()('url', {}, {}))).rejects.toThrow(
      'API returned error status: 429 quota exceeded',
    );
  });

  it('yields nothing when the API answered without a body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {status: 204}),
    );

    expect(await collect(createGdaStream()('url', {}, {}))).toEqual([]);
  });
});
