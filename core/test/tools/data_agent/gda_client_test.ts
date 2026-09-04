/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/tools/test__gda_stream_util.py`. The ported cases keep
 * their Python names. The three `get_gda_session` mTLS cases are not ported:
 * they assert `configure_mtls_channel()` on a `requests` AuthorizedSession,
 * and this port has no mTLS branch.
 */

import {OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
// Not part of the public entry point: the toolset is the only caller, so the
// client is imported from the source it lives in.
import {
  createGdaSession,
  extractDataResult,
  formatDataRetrieved,
  gdaHeaders,
  GdaSession,
  isRecord,
  resolveGdaEndpoint,
  streamChat,
} from '../../../src/tools/data_agent/gda_client.js';
import {FakeGdaSession} from './data_agent_test_utils.js';

/** Streams `lines` through the real accumulator. */
function chatOver(lines: string[], maxRows = 10): Promise<unknown[]> {
  const session = new FakeGdaSession().stream(...lines);
  return streamChat(session, 'url', {}, {}, maxRows);
}

/** A response whose body is `chunks`, one `fetch` answer. */
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

/** An auth client that answers without reaching the network. */
function testAuthClient(): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({
    access_token: 'test-access-token',
    expiry_date: Date.now() + 3_600_000,
  });
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gda_client, ported from test__gda_stream_util.py', () => {
  it('test_extract_data_result_success', () => {
    const message = {
      systemMessage: {data: {result: {data: [1, 2], schema: {}}}},
    };
    expect(extractDataResult(message)).toEqual({data: [1, 2], schema: {}});
  });

  it('test_extract_data_result_failure', () => {
    expect(extractDataResult({})).toBeUndefined();
    expect(extractDataResult({systemMessage: null})).toBeUndefined();
    expect(extractDataResult({systemMessage: {data: null}})).toBeUndefined();
    expect(
      extractDataResult({systemMessage: {data: {result: null}}}),
    ).toBeUndefined();
    expect(
      extractDataResult({systemMessage: {data: {result: {no_data: 1}}}}),
    ).toBeUndefined();
  });

  it('test_format_data_retrieved_simple', () => {
    const result = {
      data: [{col1: 'val1', col2: 10}],
      schema: {fields: [{name: 'col1'}, {name: 'col2'}]},
    };
    expect(formatDataRetrieved(result, 10)).toEqual({
      'Data Retrieved': {
        headers: ['col1', 'col2'],
        rows: [['val1', 10]],
        summary: 'Showing all 1 rows.',
      },
    });
  });

  it('test_format_data_retrieved_truncation', () => {
    const result = {
      data: [0, 1, 2, 3, 4].map((index) => ({col1: `val${index}`})),
      schema: {fields: [{name: 'col1'}]},
    };
    expect(formatDataRetrieved(result, 2)).toEqual({
      'Data Retrieved': {
        headers: ['col1'],
        rows: [['val0'], ['val1']],
        summary: 'Showing the first 2 of 5 total rows.',
      },
    });
  });

  it('test_format_data_retrieved_missing_schema', () => {
    const result = {data: [{col1: 'val1'}], schema: null};
    expect(formatDataRetrieved(result, 10)).toEqual({
      'Data Retrieved': {
        headers: ['col1'],
        rows: [['val1']],
        summary: 'Showing all 1 rows.',
      },
    });
  });

  it('test_get_stream', async () => {
    const messages = await chatOver([
      '[{',
      '"systemMessage": {"text": "msg1"}',
      '}',
      ',',
      '{',
      '"systemMessage": { "data": { "result": { "data": [{"a":1}],' +
        ' "schema": {"fields":[{"name":"a"}]}}}}',
      '}',
      ',',
      '{',
      '"systemMessage": { "data": { "result": { "data": [{"b":2}],' +
        ' "schema": {"fields":[{"name":"b"}]}}}}',
      '}',
      ',',
      '{',
      '"systemMessage": {"text": "msg4"}',
      '}]',
    ]);

    expect(messages).toEqual([
      {text: 'msg1'},
      {'Data Retrieved': 'Intermediate result omitted'},
      {
        'Data Retrieved': {
          headers: ['b'],
          rows: [[2]],
          summary: 'Showing all 1 rows.',
        },
      },
      {text: 'msg4'},
    ]);
  });

  it('test_get_gda_endpoint_locations', () => {
    expect(resolveGdaEndpoint({location: 'eu'})).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com',
    );
    expect(resolveGdaEndpoint({location: 'us'})).toBe(
      'https://geminidataanalytics.us.rep.googleapis.com',
    );
    expect(resolveGdaEndpoint({location: 'us-central1'})).toBe(
      'https://geminidataanalytics-us-central1.googleapis.com',
    );
    expect(resolveGdaEndpoint({location: 'global'})).toBe(
      'https://geminidataanalytics.googleapis.com',
    );
  });

  it('test_get_gda_endpoint_custom_override', () => {
    expect(resolveGdaEndpoint({apiEndpoint: 'custom.googleapis.com'})).toBe(
      'https://custom.googleapis.com',
    );
    expect(resolveGdaEndpoint({apiEndpoint: 'https://foo.bar.com'})).toBe(
      'https://foo.bar.com',
    );
  });
});

describe('resolveGdaEndpoint', () => {
  it('falls back to the global host when no location is given', () => {
    expect(resolveGdaEndpoint()).toBe(
      'https://geminidataanalytics.googleapis.com',
    );
  });

  it('normalises the case and the surrounding whitespace of a location', () => {
    expect(resolveGdaEndpoint({location: '  EU '})).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com',
    );
    expect(resolveGdaEndpoint({location: ' GLOBAL '})).toBe(
      'https://geminidataanalytics.googleapis.com',
    );
  });

  it('lets an api endpoint win over a location', () => {
    expect(
      resolveGdaEndpoint({
        location: 'eu',
        apiEndpoint: 'http://localhost:8080',
      }),
    ).toBe('http://localhost:8080');
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

describe('isRecord', () => {
  it('accepts a plain object and rejects everything else', () => {
    expect(isRecord({a: 1})).toBe(true);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('text')).toBe(false);
  });
});

describe('streamChat', () => {
  it('skips empty lines and unparsable fragments', async () => {
    expect(await chatOver(['', '{"systemMessage"', ':{"text":"a"}}'])).toEqual([
      {text: 'a'},
    ]);
  });

  it('passes a message that is not an object through unchanged', async () => {
    expect(await chatOver(['[1, 2]', '"plain"'])).toEqual([[1, 2], 'plain']);
  });

  it('keeps a message whose systemMessage is not an object', async () => {
    expect(await chatOver(['{"systemMessage": 7}'])).toEqual([
      {systemMessage: 7},
    ]);
  });

  it('reads the headers off the first row when the schema names none', async () => {
    const messages = await chatOver([
      '{"systemMessage":{"data":{"result":{"data":[{"z":1}]}}}}',
    ]);
    expect(messages).toEqual([
      {
        'Data Retrieved': {
          headers: ['z'],
          rows: [[1]],
          summary: 'Showing all 1 rows.',
        },
      },
    ]);
  });

  it('reports no headers for a result with no rows and no schema', async () => {
    const messages = await chatOver([
      '{"systemMessage":{"data":{"result":{"data":[]}}}}',
    ]);
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

  it('drops a schema field with no string name, and a non-object row', async () => {
    const messages = await chatOver([
      '{"systemMessage":{"data":{"result":{"data":[{"a":1},7],' +
        '"schema":{"fields":[{"name":"a"},{"name":9},"x"]}}}}}',
    ]);
    expect(messages).toEqual([
      {
        'Data Retrieved': {
          headers: ['a'],
          rows: [[1]],
          summary: 'Showing all 2 rows.',
        },
      },
    ]);
  });
});

describe('formatDataRetrieved', () => {
  it('reports no rows for a result whose data is not an array', () => {
    expect(formatDataRetrieved({data: 'nope'}, 10)).toEqual({
      'Data Retrieved': {
        headers: [],
        rows: [],
        summary: 'Showing all 0 rows.',
      },
    });
  });
});

describe('createGdaSession', () => {
  it('reports the host the endpoint options select', async () => {
    const {endpoint} = await createGdaSession(undefined, {location: 'eu'});
    expect(endpoint).toBe('https://geminidataanalytics.eu.rep.googleapis.com');
  });

  it('sends the method, the body, the query and the credential', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true}', {status: 200}));
    vi.stubGlobal('fetch', fetchSpy);

    const {session} = await createGdaSession(testAuthClient());
    const response = await session.request({
      method: 'POST',
      url: 'https://geminidataanalytics.googleapis.com/v1/agents',
      headers: gdaHeaders(),
      timeoutSeconds: 30,
      params: {dataAgentId: 'agent 1'},
      body: {displayName: 'test'},
    });

    expect(response).toEqual({ok: true, status: 200, text: '{"ok":true}'});
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'https://geminidataanalytics.googleapis.com/v1/agents?dataAgentId=agent+1',
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"displayName":"test"}');
    expect(init.headers.get('X-Goog-API-Client')).toBe('GOOGLE_ADK');
    expect(init.headers.get('Authorization')).toBe('Bearer test-access-token');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends no body and no Authorization header when it has neither', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response('nope', {status: 404}));
    vi.stubGlobal('fetch', fetchSpy);

    const {session} = await createGdaSession(undefined);
    const response = await session.request({
      method: 'GET',
      url: 'https://geminidataanalytics.googleapis.com/v1/agents',
      headers: {},
      timeoutSeconds: 5,
    });

    expect(response).toEqual({ok: false, status: 404, text: 'nope'});
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.body).toBeUndefined();
    expect(init.headers.get('Authorization')).toBeNull();
  });

  it('splits the streamed body into lines across chunk boundaries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamingResponse(['[{\r\n"a', '": 1}\n}]'])),
    );

    const {session} = await createGdaSession(undefined);
    expect(await collect(session)).toEqual(['[{', '"a": 1}', '}]']);
  });

  it('throws when the chat endpoint answers with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('denied', {status: 403})),
    );

    const {session} = await createGdaSession(undefined);
    await expect(collect(session)).rejects.toThrow(
      'API returned error status: 403 denied',
    );
  });

  it('yields nothing when the response carries no body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, {status: 204})),
    );

    const {session} = await createGdaSession(undefined);
    expect(await collect(session)).toEqual([]);
  });
});

/** Drains one chat stream into an array. */
async function collect(session: GdaSession): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of session.streamLines(
    'https://host/v1:chat',
    {},
    {},
  )) {
    lines.push(line);
  }
  return lines;
}
