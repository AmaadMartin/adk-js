/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';

import {
  createRecordingFetch,
  getHttpDebugSink,
  HttpDebugExchange,
  runWithHttpDebugSink,
} from '../../../src/tools/mcp/http_debug_recorder.js';
// The logger singleton is internal, so it is imported by relative path to spy
// on the exact instance the recorder uses.
import {logger} from '../../../src/utils/logger.js';

const MAX_BODY_LENGTH = 1000;
const MAX_RECORDED_EXCHANGES = 50;

function jsonResponse(
  body: string,
  init: {status?: number; headers?: Record<string, string>} = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {'content-type': 'application/json', ...init.headers},
  });
}

function onlyExchange(sink: HttpDebugExchange[]): HttpDebugExchange {
  expect(sink).toHaveLength(1);
  return sink[0];
}

describe('runWithHttpDebugSink', () => {
  it('exposes no sink outside a run', () => {
    expect(getHttpDebugSink()).toBeUndefined();
  });

  it('exposes the sink inside a run', () => {
    const sink: HttpDebugExchange[] = [];
    runWithHttpDebugSink(sink, () => {
      expect(getHttpDebugSink()).toBe(sink);
    });
  });

  it('restores the outer sink after a run', () => {
    runWithHttpDebugSink([], () => {});
    expect(getHttpDebugSink()).toBeUndefined();
  });

  it('propagates the sink across an await', async () => {
    const sink: HttpDebugExchange[] = [];
    await runWithHttpDebugSink(sink, async () => {
      await Promise.resolve();
      expect(getHttpDebugSink()).toBe(sink);
    });
  });
});

describe('createRecordingFetch', () => {
  it('records the request and response of one exchange', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse('{"result":"ok"}', {status: 202}));

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{"method":"tools/call"}',
    });

    expect(onlyExchange(sink)).toEqual({
      url: 'https://mcp.example/mcp',
      status_code: 202,
      method: 'POST',
      request_headers: {'content-type': 'application/json'},
      request_body: '{"method":"tools/call"}',
      response_headers: {'content-type': 'application/json'},
      response_body: '{"result":"ok"}',
    });
  });

  it('returns the response untouched for the transport to read', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse('{"a":1}'));

    const response = await createRecordingFetch(sink, baseFetch)(
      'https://mcp.example/mcp',
      {method: 'POST'},
    );

    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe('{"a":1}');
  });

  it('defaults the method to GET', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse('{}'));

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp');

    expect(onlyExchange(sink).method).toBe('GET');
  });

  it('masks a credential embedded in the URL', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse('{}'));

    await createRecordingFetch(
      sink,
      baseFetch,
    )('https://user:hunter2@mcp.example/mcp');

    expect(onlyExchange(sink).url).not.toContain('hunter2');
  });

  it.each([
    'api-key',
    'authorization',
    'cookie',
    'proxy-authorization',
    'x-api-key',
    'x-goog-api-key',
  ])('redacts the %s request header', async (name) => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse('{}'));

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp', {
      method: 'POST',
      headers: {[name]: 'super-secret'},
    });

    expect(onlyExchange(sink).request_headers[name]).toBe('<redacted>');
  });

  it('redacts the set-cookie response header', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse('{}', {headers: {'set-cookie': 'session=secret'}}),
      );

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp');

    expect(onlyExchange(sink).response_headers['set-cookie']).toBe(
      '<redacted>',
    );
  });

  it('truncates a request body past the cap', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse('{}'));

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp', {
      method: 'POST',
      body: 'x'.repeat(MAX_BODY_LENGTH + 1),
    });

    expect(onlyExchange(sink).request_body).toBe(
      'x'.repeat(MAX_BODY_LENGTH) + '... [truncated]',
    );
  });

  it('keeps a request body exactly at the cap', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse('{}'));

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp', {
      method: 'POST',
      body: 'x'.repeat(MAX_BODY_LENGTH),
    });

    expect(onlyExchange(sink).request_body).toBe('x'.repeat(MAX_BODY_LENGTH));
  });

  it('truncates a response body past the cap', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse('y'.repeat(MAX_BODY_LENGTH + 5)));

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp');

    expect(onlyExchange(sink).response_body).toBe(
      'y'.repeat(MAX_BODY_LENGTH) + '... [truncated]',
    );
  });

  it('skips a request body that is not a string', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse('{}'));

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    });

    expect(onlyExchange(sink).request_body).toBeUndefined();
  });

  it('does not read an event-stream body', async () => {
    const sink: HttpDebugExchange[] = [];
    const stream = new Response('data: hello\n\n', {
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
    });
    const baseFetch = vi.fn().mockResolvedValue(stream);

    const response = await createRecordingFetch(
      sink,
      baseFetch,
    )('https://mcp.example/mcp');

    expect(onlyExchange(sink).response_body).toBe('<SSE stream>');
    expect(response.bodyUsed).toBe(false);
  });

  it('records a response that declares no content type', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi
      .fn()
      .mockResolvedValue(new Response(null, {status: 204}));

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp');

    expect(onlyExchange(sink)).toMatchObject({
      status_code: 204,
      response_body: '',
    });
  });

  it('describes a body it cannot read', async () => {
    const sink: HttpDebugExchange[] = [];
    const unreadable = jsonResponse('{}');
    vi.spyOn(unreadable, 'clone').mockImplementation(() => {
      throw new Error('body already consumed');
    });
    const baseFetch = vi.fn().mockResolvedValue(unreadable);

    await createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp');

    expect(onlyExchange(sink).response_body).toBe(
      '<failed to read body: body already consumed>',
    );
  });

  it('stops recording at the cap but keeps serving requests', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockImplementation(() => jsonResponse('{}'));
    const recording = createRecordingFetch(sink, baseFetch);

    for (let i = 0; i < MAX_RECORDED_EXCHANGES + 5; i++) {
      await recording('https://mcp.example/mcp');
    }

    expect(sink).toHaveLength(MAX_RECORDED_EXCHANGES);
    expect(baseFetch).toHaveBeenCalledTimes(MAX_RECORDED_EXCHANGES + 5);
  });

  it('logs and swallows a failure while recording', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse('{"a":1}'));

    // An invalid header name makes the `Headers` constructor throw, which is
    // the recorder's own failure and must not reach the caller.
    const response = await createRecordingFetch(sink, baseFetch)(
      'https://mcp.example/mcp',
      {method: 'POST', headers: {'in valid': 'x'}},
    );

    expect(sink).toHaveLength(0);
    await expect(response.text()).resolves.toBe('{"a":1}');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to record an MCP HTTP exchange'),
    );
    warnSpy.mockRestore();
  });

  it('propagates a transport failure without recording', async () => {
    const sink: HttpDebugExchange[] = [];
    const baseFetch = vi.fn().mockRejectedValue(new Error('connect refused'));

    await expect(
      createRecordingFetch(sink, baseFetch)('https://mcp.example/mcp'),
    ).rejects.toThrow('connect refused');
    expect(sink).toHaveLength(0);
  });
});
