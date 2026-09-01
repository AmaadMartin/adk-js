/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {MAX_LOG_BODY_LENGTH} from '../../src/utils/error_utils.js';
import {
  captureHttpDebug,
  HttpDebugRecord,
  instrumentFetch,
  MAX_HTTP_DEBUG_RECORDS,
  recordHttpDebug,
} from '../../src/utils/http_debug_utils.js';

function makeRecord(overrides: Partial<HttpDebugRecord> = {}): HttpDebugRecord {
  return {
    url: 'https://mcp.example.com/mcp',
    status_code: 200,
    method: 'POST',
    request_headers: {},
    response_headers: {},
    ...overrides,
  };
}

describe('captureHttpDebug', () => {
  it('collects the records a producer appends during the call', async () => {
    const records: HttpDebugRecord[] = [];

    await captureHttpDebug(records, async () => {
      recordHttpDebug(makeRecord());
    });

    expect(records).toEqual([makeRecord()]);
  });

  it('keeps the records captured before the call rejected', async () => {
    const records: HttpDebugRecord[] = [];

    await expect(
      captureHttpDebug(records, async () => {
        recordHttpDebug(makeRecord());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(records).toHaveLength(1);
  });

  it('keeps two concurrent captures apart', async () => {
    const first: HttpDebugRecord[] = [];
    const second: HttpDebugRecord[] = [];

    await Promise.all([
      captureHttpDebug(first, async () => {
        await Promise.resolve();
        recordHttpDebug(makeRecord({url: 'https://first.example.com/'}));
      }),
      captureHttpDebug(second, async () => {
        recordHttpDebug(makeRecord({url: 'https://second.example.com/'}));
      }),
    ]);

    expect(first.map((record) => record.url)).toEqual([
      'https://first.example.com/',
    ]);
    expect(second.map((record) => record.url)).toEqual([
      'https://second.example.com/',
    ]);
  });
});

describe('recordHttpDebug', () => {
  it('does nothing outside a capture', () => {
    expect(() => recordHttpDebug(makeRecord())).not.toThrow();
  });

  it('stops appending at the record cap', async () => {
    const records: HttpDebugRecord[] = [];

    await captureHttpDebug(records, async () => {
      for (let i = 0; i <= MAX_HTTP_DEBUG_RECORDS; i++) {
        recordHttpDebug(makeRecord({status_code: i}));
      }
    });

    expect(records).toHaveLength(MAX_HTTP_DEBUG_RECORDS);
    expect(records[records.length - 1].status_code).toBe(
      MAX_HTTP_DEBUG_RECORDS - 1,
    );
  });

  it('truncates a body longer than the cap', async () => {
    const records: HttpDebugRecord[] = [];
    const body = 'x'.repeat(MAX_LOG_BODY_LENGTH + 50);

    await captureHttpDebug(records, async () => {
      recordHttpDebug(makeRecord({request_body: body, response_body: body}));
    });

    expect(records[0].request_body).toBe(
      'x'.repeat(MAX_LOG_BODY_LENGTH) + '... [truncated]',
    );
    expect(records[0].response_body).toBe(
      'x'.repeat(MAX_LOG_BODY_LENGTH) + '... [truncated]',
    );
  });

  it('leaves a body at the cap untouched', async () => {
    const records: HttpDebugRecord[] = [];
    const body = 'x'.repeat(MAX_LOG_BODY_LENGTH);

    await captureHttpDebug(records, async () => {
      recordHttpDebug(makeRecord({response_body: body}));
    });

    expect(records[0].response_body).toBe(body);
  });
});

describe('instrumentFetch', () => {
  it('records the exchange with credentials masked', async () => {
    const records: HttpDebugRecord[] = [];
    const instrumented = instrumentFetch(
      async () =>
        new Response('{"result":"ok"}', {
          status: 201,
          headers: {'content-type': 'application/json', 'set-cookie': 'sid=1'},
        }),
    );
    // Assembled rather than written out, so the fixture is not a literal
    // credential in the source.
    const credentialed = new URL('https://mcp.example.com/mcp');
    credentialed.username = 'operator';
    credentialed.password = 'not-a-real-secret';

    await captureHttpDebug(records, () =>
      instrumented(credentialed, {
        method: 'POST',
        headers: {Authorization: 'Bearer token', 'X-Trace': 'keep-me'},
        body: '{"method":"tools/call"}',
      }),
    );

    expect(records).toEqual([
      {
        url: `https://${credentialed.username}:***@mcp.example.com/mcp`,
        status_code: 201,
        method: 'POST',
        request_headers: {
          'authorization': '<redacted>',
          'x-trace': 'keep-me',
        },
        request_body: '{"method":"tools/call"}',
        response_headers: {
          'content-type': 'application/json',
          'set-cookie': '<redacted>',
        },
        response_body: '{"result":"ok"}',
      },
    ]);
  });

  it('leaves the response readable by the caller', async () => {
    const records: HttpDebugRecord[] = [];
    const instrumented = instrumentFetch(
      async () => new Response('{"result":"ok"}'),
    );

    const response = await captureHttpDebug(records, () =>
      instrumented('https://mcp.example.com/mcp'),
    );

    expect(await response.text()).toBe('{"result":"ok"}');
    expect(records[0].response_body).toBe('{"result":"ok"}');
  });

  it('records an SSE response without consuming its body', async () => {
    const records: HttpDebugRecord[] = [];
    const instrumented = instrumentFetch(
      async () =>
        new Response('data: hello\n\n', {
          headers: {'content-type': 'text/event-stream; charset=utf-8'},
        }),
    );

    const response = await captureHttpDebug(records, () =>
      instrumented('https://mcp.example.com/mcp'),
    );

    expect(records[0].response_body).toBe('<SSE stream>');
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('data: hello\n\n');
  });

  it('defaults the method to GET and omits an absent request body', async () => {
    const records: HttpDebugRecord[] = [];
    const instrumented = instrumentFetch(async () => new Response('ok'));

    await captureHttpDebug(records, () =>
      instrumented(new URL('https://mcp.example.com/mcp')),
    );

    expect(records[0].method).toBe('GET');
    expect('request_body' in records[0]).toBe(false);
  });

  it('records nothing outside a capture', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const instrumented = instrumentFetch(base);

    const response = await instrumented('https://mcp.example.com/mcp');

    expect(await response.text()).toBe('ok');
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('delegates to the global fetch when given none', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('global'));

    const response = await instrumentFetch()('https://mcp.example.com/mcp');

    expect(await response.text()).toBe('global');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    globalFetch.mockRestore();
  });

  it('still returns the response when building the record fails', async () => {
    const records: HttpDebugRecord[] = [];
    const instrumented = instrumentFetch(async () => new Response('ok'));

    const response = await captureHttpDebug(records, () =>
      // `new Headers` rejects a name containing a space, which fails the
      // record build after the request already succeeded.
      instrumented('https://mcp.example.com/mcp', {
        headers: {'invalid header name': 'x'},
      }),
    );

    expect(await response.text()).toBe('ok');
    expect(records).toEqual([]);
  });

  it('reports a body it could not read', async () => {
    const records: HttpDebugRecord[] = [];
    const instrumented = instrumentFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('stream broke'));
            },
          }),
        ),
    );

    await captureHttpDebug(records, () =>
      instrumented('https://mcp.example.com/mcp'),
    );

    expect(records[0].response_body).toContain('failed to read body');
  });
});
