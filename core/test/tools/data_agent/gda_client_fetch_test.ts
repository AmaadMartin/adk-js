/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the Conversational Analytics client the BigQuery `ask_data_insights`
 * tool streams through: the host it picks, the accumulator that turns a
 * streamed JSON array back into messages, and the `fetch` session.
 *
 * The module is carried over from the parity branch, which has its own test
 * for it. That test drives the client through the data agent fixtures, which
 * this branch does not carry, so this file exercises the same module from the
 * BigQuery side.
 */

import {
  GdaRequest,
  GdaResponse,
  GdaSession,
  createGdaSession,
  extractDataResult,
  formatDataRetrieved,
  gdaHeaders,
  resolveGdaEndpoint,
  streamChat,
} from '@google/adk/tools/data_agent/gda_client.js';
import {OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';

/** A session that replays `lines`, so the real accumulator runs over them. */
class ReplaySession implements GdaSession {
  constructor(private readonly lines: string[]) {}

  async request(_request: GdaRequest): Promise<GdaResponse> {
    return {ok: true, status: 200, text: ''};
  }

  async *streamLines(): AsyncGenerator<string> {
    for (const line of this.lines) {
      yield line;
    }
  }
}

/** Streams `lines` through the real accumulator. */
function chatOver(lines: string[], maxRows = 10): Promise<unknown[]> {
  return streamChat(new ReplaySession(lines), 'url', {}, {}, maxRows);
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

/** Reads a session's stream to the end. */
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
    expect(resolveGdaEndpoint({location: '  GLOBAL '})).toBe(
      'https://geminidataanalytics.googleapis.com',
    );
  });

  it('uses a regional endpoint product host for eu and us', () => {
    expect(resolveGdaEndpoint({location: 'EU'})).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com',
    );
    expect(resolveGdaEndpoint({location: 'us'})).toBe(
      'https://geminidataanalytics.us.rep.googleapis.com',
    );
  });

  it('uses a regional host for any other location', () => {
    expect(resolveGdaEndpoint({location: 'europe-west1'})).toBe(
      'https://geminidataanalytics-europe-west1.googleapis.com',
    );
  });

  it('prefers an explicit endpoint, adding a scheme when it lacks one', () => {
    expect(resolveGdaEndpoint({apiEndpoint: 'gda.example'})).toBe(
      'https://gda.example',
    );
    expect(resolveGdaEndpoint({apiEndpoint: 'http://gda.example'})).toBe(
      'http://gda.example',
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
    const result = formatDataRetrieved({data: [{a: 1}, {a: 2}, {a: 3}]}, 2);
    expect(result).toEqual({
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
      JSON.stringify({
        systemMessage: {data: {result: {data: [{a: value}]}}},
      });

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

describe('createGdaSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a session against the host the location picks', async () => {
    const {endpoint} = await createGdaSession(undefined, {location: 'eu'});

    expect(endpoint).toBe('https://geminidataanalytics.eu.rep.googleapis.com');
  });

  it('sends a request with the credential headers and the caller headers', async () => {
    const credentials = new OAuth2Client();
    vi.spyOn(credentials, 'getRequestHeaders').mockResolvedValue(
      new Headers({authorization: 'Bearer token'}),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', {status: 200}));
    const {session} = await createGdaSession(credentials);

    const response = await session.request({
      method: 'POST',
      url: 'https://gda.example/v1/chat',
      headers: {'X-Goog-API-Client': 'GOOGLE_ADK'},
      timeoutSeconds: 5,
      params: {alt: 'json'},
      body: {a: 1},
    });

    expect(response).toEqual({ok: true, status: 200, text: '{"ok":true}'});
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gda.example/v1/chat?alt=json');
    const headers = init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('X-Goog-API-Client')).toBe('GOOGLE_ADK');
    expect(init?.body).toBe('{"a":1}');
  });

  it('sends an unauthenticated request with no body when there is none', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', {status: 404}));
    const {session} = await createGdaSession(undefined);

    const response = await session.request({
      method: 'GET',
      url: 'https://gda.example/v1/agents',
      headers: {},
      timeoutSeconds: 5,
    });

    expect(response).toEqual({ok: false, status: 404, text: ''});
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('splits a streamed body into lines, dropping the terminators', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamingResponse(['[{\r\n"a":', '1}]\n{"b":2}']),
    );
    const {session} = await createGdaSession(undefined);

    expect(await collect(session.streamLines('url', {}, {}))).toEqual([
      '[{',
      '"a":1}]',
      '{"b":2}',
    ]);
  });

  it('reports the status when the API refused the stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('quota exceeded', {status: 429}),
    );
    const {session} = await createGdaSession(undefined);

    await expect(collect(session.streamLines('url', {}, {}))).rejects.toThrow(
      'API returned error status: 429 quota exceeded',
    );
  });

  it('yields nothing when the API answered without a body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {status: 204}),
    );
    const {session} = await createGdaSession(undefined);

    expect(await collect(session.streamLines('url', {}, {}))).toEqual([]);
  });
});
