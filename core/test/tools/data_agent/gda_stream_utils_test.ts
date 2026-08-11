/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  extractDataResult,
  formatDataRetrieved,
  getGdaEndpoint,
  readGdaStream,
  throwIfNotOk,
} from '../../../src/tools/data_agent/gda_stream_utils.js';

const GLOBAL_ENDPOINT = 'https://geminidataanalytics.googleapis.com';

/**
 * The exact fixture from the adk-python `get_stream` test, one array element
 * per line, as the Gemini Data Analytics API streams it.
 */
const PYTHON_STREAM_FIXTURE = [
  '[{',
  '"systemMessage": {"text": "msg1"}',
  '}',
  ',',
  '{',
  '"systemMessage": { "data": { "result": { "data": [{"a":1}], "schema": {"fields":[{"name":"a"}]}}}}',
  '}',
  ',',
  '{',
  '"systemMessage": { "data": { "result": { "data": [{"b":2}], "schema": {"fields":[{"name":"b"}]}}}}',
  '}',
  ',',
  '{',
  '"systemMessage": {"text": "msg4"}',
  '}]',
].join('\n');

/** Builds a real streaming `Response` over the given body chunks. */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream);
}

/** Splits `text` into `size`-character chunks, to exercise chunk boundaries. */
function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    chunks.push(text.slice(start, start + size));
  }
  return chunks;
}

describe('getGdaEndpoint', () => {
  it('returns the global endpoint when no location is given', () => {
    expect(getGdaEndpoint()).toBe(GLOBAL_ENDPOINT);
    expect(getGdaEndpoint({})).toBe(GLOBAL_ENDPOINT);
    expect(getGdaEndpoint({location: 'global'})).toBe(GLOBAL_ENDPOINT);
  });

  it('returns the regional endpoint program host for eu and us', () => {
    expect(getGdaEndpoint({location: 'eu'})).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com',
    );
    expect(getGdaEndpoint({location: 'us'})).toBe(
      'https://geminidataanalytics.us.rep.googleapis.com',
    );
  });

  it('returns the regional host for any other location', () => {
    expect(getGdaEndpoint({location: 'us-central1'})).toBe(
      'https://geminidataanalytics-us-central1.googleapis.com',
    );
  });

  it('lowercases and trims the location before matching', () => {
    expect(getGdaEndpoint({location: 'EU'})).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com',
    );
    expect(getGdaEndpoint({location: '  eu  '})).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com',
    );
    expect(getGdaEndpoint({location: '  GLOBAL '})).toBe(GLOBAL_ENDPOINT);
  });

  it('adds https to a custom endpoint that has no scheme', () => {
    expect(getGdaEndpoint({apiEndpoint: 'custom.googleapis.com'})).toBe(
      'https://custom.googleapis.com',
    );
  });

  it('keeps a custom endpoint that already has a scheme', () => {
    expect(getGdaEndpoint({apiEndpoint: 'https://foo.bar.com'})).toBe(
      'https://foo.bar.com',
    );
  });

  it('prefers the custom endpoint over the location', () => {
    expect(
      getGdaEndpoint({location: 'eu', apiEndpoint: 'https://foo.bar.com'}),
    ).toBe('https://foo.bar.com');
  });

  it('rejects a location that would escape the googleapis.com authority', () => {
    for (const location of [
      'a@evil.example#',
      'a.evil.example',
      'a/../../evil',
      'a:8080',
      'a?x=1',
      'a\\evil.example',
      'a b',
    ]) {
      expect(() => getGdaEndpoint({location})).toThrowError(
        /Invalid Data Agent location/,
      );
    }
  });

  it('keeps every accepted location inside googleapis.com', () => {
    for (const location of ['eu', 'us', 'us-central1', 'asia-northeast1']) {
      expect(new URL(getGdaEndpoint({location})).hostname).toMatch(
        /\.googleapis\.com$/,
      );
    }
  });
});

describe('throwIfNotOk', () => {
  it('throws with the status and the URL for a non-2xx response', () => {
    const url = `${GLOBAL_ENDPOINT}/v1/projects/p/locations/global`;

    expect(() =>
      throwIfNotOk(
        new Response('denied', {status: 403, statusText: 'Forbidden'}),
        url,
      ),
    ).toThrowError(`HTTP 403 Forbidden for ${url}`);
  });

  it('does not throw for a 2xx response', () => {
    expect(() =>
      throwIfNotOk(new Response('{}', {status: 200}), GLOBAL_ENDPOINT),
    ).not.toThrow();
  });
});

describe('extractDataResult', () => {
  it('returns the result when it carries a row array', () => {
    expect(
      extractDataResult({
        systemMessage: {data: {result: {data: [1, 2], schema: {}}}},
      }),
    ).toEqual({data: [1, 2], schema: {}});
  });

  it('returns undefined for every other message shape', () => {
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

  it('returns undefined for a non-object message', () => {
    expect(extractDataResult(['not', 'a', 'record'])).toBeUndefined();
    expect(extractDataResult('text')).toBeUndefined();
  });
});

describe('formatDataRetrieved', () => {
  it('projects the rows onto the schema field names', () => {
    expect(
      formatDataRetrieved(
        {
          data: [{col1: 'val1', col2: 10}],
          schema: {fields: [{name: 'col1'}, {name: 'col2'}]},
        },
        10,
      ),
    ).toEqual({
      'Data Retrieved': {
        headers: ['col1', 'col2'],
        rows: [['val1', 10]],
        summary: 'Showing all 1 rows.',
      },
    });
  });

  it('truncates to maxRows and reports the total', () => {
    expect(
      formatDataRetrieved(
        {
          data: [0, 1, 2, 3, 4].map((i) => ({col1: `val${i}`})),
          schema: {fields: [{name: 'col1'}]},
        },
        2,
      ),
    ).toEqual({
      'Data Retrieved': {
        headers: ['col1'],
        rows: [['val0'], ['val1']],
        summary: 'Showing the first 2 of 5 total rows.',
      },
    });
  });

  it('falls back to the first row keys when the schema is missing', () => {
    expect(
      formatDataRetrieved({data: [{col1: 'val1'}], schema: null}, 10),
    ).toEqual({
      'Data Retrieved': {
        headers: ['col1'],
        rows: [['val1']],
        summary: 'Showing all 1 rows.',
      },
    });
  });

  it('falls back to the first row keys when the fields are not an array', () => {
    expect(
      formatDataRetrieved(
        {data: [{col1: 'val1'}], schema: {fields: 'nope'}},
        10,
      ),
    ).toEqual({
      'Data Retrieved': {
        headers: ['col1'],
        rows: [['val1']],
        summary: 'Showing all 1 rows.',
      },
    });
  });

  it('skips schema fields without a string name', () => {
    expect(
      formatDataRetrieved(
        {
          data: [{a: 1, b: 2}],
          schema: {fields: [{name: 7}, 'plain', {name: 'b'}]},
        },
        10,
      ),
    ).toEqual({
      'Data Retrieved': {
        headers: ['b'],
        rows: [[2]],
        summary: 'Showing all 1 rows.',
      },
    });
  });

  it('skips rows that are not objects but still counts them', () => {
    expect(
      formatDataRetrieved(
        {data: [{a: 1}, 'nope'], schema: {fields: [{name: 'a'}]}},
        10,
      ),
    ).toEqual({
      'Data Retrieved': {
        headers: ['a'],
        rows: [[1]],
        summary: 'Showing all 2 rows.',
      },
    });
  });

  it('returns an empty table for an empty row array', () => {
    expect(formatDataRetrieved({data: []}, 10)).toEqual({
      'Data Retrieved': {
        headers: [],
        rows: [],
        summary: 'Showing all 0 rows.',
      },
    });
  });
});

describe('readGdaStream', () => {
  it('reads the adk-python stream fixture into four messages', async () => {
    const messages = await readGdaStream(
      streamingResponse([PYTHON_STREAM_FIXTURE]),
      10,
    );

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

  it('reassembles a message split across chunk boundaries', async () => {
    const messages = await readGdaStream(
      streamingResponse(chunked(PYTHON_STREAM_FIXTURE, 7)),
      10,
    );

    expect(messages).toHaveLength(4);
    expect(messages[3]).toEqual({text: 'msg4'});
  });

  it('applies maxQueryResultRows to the final table', async () => {
    const rows = [{a: 1}, {a: 2}, {a: 3}];
    const body = [
      '[{',
      `"systemMessage": {"data": {"result": {"data": ${JSON.stringify(rows)}, "schema": {"fields":[{"name":"a"}]}}}}`,
      '}]',
    ].join('\n');

    const messages = await readGdaStream(streamingResponse([body]), 2);

    expect(messages).toEqual([
      {
        'Data Retrieved': {
          headers: ['a'],
          rows: [[1], [2]],
          summary: 'Showing the first 2 of 3 total rows.',
        },
      },
    ]);
  });

  it('skips blank lines and strips carriage returns', async () => {
    const body = ['[{', '', '"systemMessage": {"text": "msg1"}', '', '}]'].join(
      '\r\n',
    );

    expect(await readGdaStream(streamingResponse([body]), 10)).toEqual([
      {text: 'msg1'},
    ]);
  });

  it('passes through a message that is not an object', async () => {
    const body = ['42', '[1, 2]', '"plain"'].join('\n');

    expect(await readGdaStream(streamingResponse([body]), 10)).toEqual([
      42,
      [1, 2],
      'plain',
    ]);
  });

  it('passes through an object with no systemMessage', async () => {
    expect(
      await readGdaStream(streamingResponse(['{"error": {"code": 7}}']), 10),
    ).toEqual([{error: {code: 7}}]);
  });

  it('returns no messages for an empty body', async () => {
    expect(await readGdaStream(streamingResponse([]), 10)).toEqual([]);
  });

  it('returns no messages when the response has no body at all', async () => {
    const bodyless = new Response(null, {status: 204});

    expect(bodyless.body).toBeNull();
    expect(await readGdaStream(bodyless, 10)).toEqual([]);
  });

  it('rejects when the stream errors mid-read', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{\n'));
        controller.error(new Error('connection reset'));
      },
    });

    await expect(readGdaStream(new Response(stream), 10)).rejects.toThrow(
      'connection reset',
    );
  });
});
