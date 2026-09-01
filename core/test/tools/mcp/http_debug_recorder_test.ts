/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  createRecordingFetch,
  getHttpDebugSink,
  HttpDebugExchange,
  runWithHttpDebugSink,
} from '../../../src/tools/mcp/http_debug_recorder.js';
import {logger} from '../../../src/utils/logger.js';
import {REDACTED_HEADER_VALUE} from '../../../src/utils/redact_headers.js';

/** A fetch that answers every request with `response`. */
function respondWith(response: Response): typeof fetch {
  return vi.fn().mockResolvedValue(response);
}

describe('runWithHttpDebugSink', () => {
  it('exposes the sink to the work it runs', () => {
    const sink: HttpDebugExchange[] = [];

    const seen = runWithHttpDebugSink(sink, () => getHttpDebugSink());

    expect(seen).toBe(sink);
  });

  it('exposes the sink across an await', async () => {
    const sink: HttpDebugExchange[] = [];

    const seen = await runWithHttpDebugSink(sink, async () => {
      await Promise.resolve();
      return getHttpDebugSink();
    });

    expect(seen).toBe(sink);
  });

  it('reports no sink outside the callback', () => {
    expect(getHttpDebugSink()).toBeUndefined();
  });
});

describe('createRecordingFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the request and the response', async () => {
    const sink: HttpDebugExchange[] = [];
    const recording = createRecordingFetch(
      sink,
      respondWith(
        new Response('{"result":1}', {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
      ),
    );

    const response = await recording('https://example.com/mcp', {
      method: 'POST',
      body: '{"jsonrpc":"2.0"}',
      headers: {'content-type': 'application/json'},
    });

    expect(await response.text()).toBe('{"result":1}');
    expect(sink).toEqual([
      {
        url: 'https://example.com/mcp',
        status_code: 200,
        method: 'POST',
        request_headers: {'content-type': 'application/json'},
        request_body: '{"jsonrpc":"2.0"}',
        response_headers: {'content-type': 'application/json'},
        response_body: '{"result":1}',
      },
    ]);
  });

  it('defaults the method to GET and omits a non-string body', async () => {
    const sink: HttpDebugExchange[] = [];
    const recording = createRecordingFetch(sink, respondWith(new Response('')));

    await recording('https://example.com/mcp', {body: new Uint8Array([1, 2])});

    expect(sink[0].method).toBe('GET');
    expect(sink[0].request_body).toBeUndefined();
  });

  it('masks a credential in the request and response headers', async () => {
    const sink: HttpDebugExchange[] = [];
    const recording = createRecordingFetch(
      sink,
      respondWith(new Response('', {headers: {'set-cookie': 'session=abc'}})),
    );

    await recording('https://example.com/mcp', {
      headers: {authorization: 'Bearer token'},
    });

    expect(sink[0].request_headers['authorization']).toBe(
      REDACTED_HEADER_VALUE,
    );
    expect(sink[0].response_headers['set-cookie']).toBe(REDACTED_HEADER_VALUE);
  });

  it('masks a credential in the URL', async () => {
    const sink: HttpDebugExchange[] = [];
    const recording = createRecordingFetch(sink, respondWith(new Response('')));

    await recording('https://user:hunter2@example.com/mcp');

    expect(sink[0].url).toBe('https://user:***@example.com/mcp');
  });

  it('never reads an event-stream body', async () => {
    const sink: HttpDebugExchange[] = [];
    const body = new Response('data: one\n\n', {
      headers: {'content-type': 'text/event-stream'},
    });
    const recording = createRecordingFetch(sink, respondWith(body));

    const response = await recording('https://example.com/mcp');

    expect(sink[0].response_body).toBe('<SSE stream>');
    expect(response.bodyUsed).toBe(false);
  });

  it('records a response that carries no content type', async () => {
    const sink: HttpDebugExchange[] = [];
    const recording = createRecordingFetch(
      sink,
      respondWith(new Response(null, {status: 204})),
    );

    await recording('https://example.com/mcp');

    expect(sink[0].status_code).toBe(204);
    expect(sink[0].response_body).toBe('');
  });

  it('truncates a body over 1000 characters', async () => {
    const sink: HttpDebugExchange[] = [];
    const long = 'x'.repeat(1500);
    const recording = createRecordingFetch(
      sink,
      respondWith(new Response(long)),
    );

    await recording('https://example.com/mcp', {method: 'POST', body: long});

    expect(sink[0].request_body).toBe('x'.repeat(1000) + '... [truncated]');
    expect(sink[0].response_body).toBe('x'.repeat(1000) + '... [truncated]');
  });

  it('describes a body it cannot read instead of failing the request', async () => {
    const sink: HttpDebugExchange[] = [];
    const response = new Response('body');
    vi.spyOn(response, 'clone').mockImplementation(() => {
      throw new Error('already consumed');
    });
    const recording = createRecordingFetch(sink, respondWith(response));

    await recording('https://example.com/mcp');

    expect(sink[0].response_body).toBe(
      '<failed to read body: already consumed>',
    );
  });

  it('stops recording at 50 exchanges', async () => {
    const sink: HttpDebugExchange[] = [];
    const recording = createRecordingFetch(sink, respondWith(new Response('')));

    for (let i = 0; i < 55; i++) {
      await recording(`https://example.com/mcp/${i}`);
    }

    expect(sink).toHaveLength(50);
    expect(sink[49].url).toBe('https://example.com/mcp/49');
  });

  it('returns the response untouched when recording throws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const sink: HttpDebugExchange[] = [];
    const response = new Response('ok');
    // A header bag that throws is the one part of the record that is not
    // already guarded, so it stands in for any recording failure.
    vi.spyOn(response.headers, 'get').mockImplementation(() => {
      throw new Error('headers exploded');
    });
    const recording = createRecordingFetch(sink, respondWith(response));

    await expect(recording('https://example.com/mcp')).resolves.toBe(response);
    expect(sink).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'Failed to record an MCP HTTP exchange: headers exploded',
    );
  });
});
