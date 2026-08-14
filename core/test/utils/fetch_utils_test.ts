/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  idleTimeoutStream,
  withStreamIdleTimeout,
} from '../../src/utils/fetch_utils.js';

const IDLE_TIMEOUT_MS = 1000;

/** A source stream whose chunks are pushed by the test. */
function controllableStream(cancel?: (reason?: unknown) => void): {
  stream: ReadableStream<Uint8Array>;
  push: (chunk: Uint8Array) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return {
    stream,
    push: (chunk) => controller?.enqueue(chunk),
    close: () => controller?.close(),
  };
}

/** Builds an event-stream response around a body that never produces data. */
function stalledEventStreamResponse(): Response {
  return new Response(controllableStream().stream, {
    headers: {'content-type': 'text/event-stream'},
  });
}

describe('idleTimeoutStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-emits every chunk and closes when the source closes', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2]));
        controller.close();
      },
    });

    const chunks: Uint8Array[] = [];
    const reader = idleTimeoutStream(source, IDLE_TIMEOUT_MS).getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(chunks).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts the idle budget on every chunk', async () => {
    const source = controllableStream();
    const reader = idleTimeoutStream(
      source.stream,
      IDLE_TIMEOUT_MS,
    ).getReader();

    const first = reader.read();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 100);
    source.push(new Uint8Array([7]));
    expect(await first).toEqual({done: false, value: new Uint8Array([7])});

    const second = reader.read();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 100);
    source.close();

    expect(await second).toEqual({done: true, value: undefined});
  });

  it('errors the stream and cancels the source once the budget elapses', async () => {
    const cancel = vi.fn();
    const source = controllableStream(cancel);
    const reader = idleTimeoutStream(
      source.stream,
      IDLE_TIMEOUT_MS,
    ).getReader();

    // The assertion is attached before the clock moves, so the rejection
    // never counts as unhandled.
    const read = expect(reader.read()).rejects.toThrow(
      `Stream idle for more than ${IDLE_TIMEOUT_MS} ms`,
    );
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    await read;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('propagates a source failure and leaves no timer behind', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('source exploded'));
      },
    });

    const reader = idleTimeoutStream(source, IDLE_TIMEOUT_MS).getReader();

    await expect(reader.read()).rejects.toThrow('source exploded');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the idle timer when the consumer cancels', async () => {
    const source = controllableStream();
    const reader = idleTimeoutStream(
      source.stream,
      IDLE_TIMEOUT_MS,
    ).getReader();

    void reader.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await reader.cancel('no longer needed');

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withStreamIdleTimeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wraps an event-stream body but keeps status, statusText and headers', async () => {
    const baseFetch = vi.fn().mockResolvedValue(
      new Response(controllableStream().stream, {
        status: 201,
        statusText: 'Created',
        headers: {'content-type': 'text/event-stream', 'x-trace': 'abc'},
      }),
    );

    const response = await withStreamIdleTimeout(
      IDLE_TIMEOUT_MS,
      baseFetch,
    )('http://test-url');

    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('x-trace')).toBe('abc');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.body).not.toBeNull();
  });

  it('fails a wrapped event-stream body that goes silent', async () => {
    vi.useFakeTimers();
    const baseFetch = vi.fn().mockResolvedValue(stalledEventStreamResponse());

    const response = await withStreamIdleTimeout(
      IDLE_TIMEOUT_MS,
      baseFetch,
    )('http://test-url');
    const body = response.body;
    if (!body) expect.fail('the wrapped event-stream response had no body');
    const read = expect(body.getReader().read()).rejects.toThrow(
      `Stream idle for more than ${IDLE_TIMEOUT_MS} ms`,
    );
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    await read;
    vi.useRealTimers();
  });

  it('returns a non-streamed response untouched', async () => {
    const original = new Response('{"ok":true}', {
      headers: {'content-type': 'application/json'},
    });
    const baseFetch = vi.fn().mockResolvedValue(original);

    const response = await withStreamIdleTimeout(
      IDLE_TIMEOUT_MS,
      baseFetch,
    )('http://test-url');

    expect(response).toBe(original);
  });

  it('returns a streamed response with no content-type untouched', async () => {
    const original = new Response(controllableStream().stream);
    const baseFetch = vi.fn().mockResolvedValue(original);

    const response = await withStreamIdleTimeout(
      IDLE_TIMEOUT_MS,
      baseFetch,
    )('http://test-url');

    expect(response).toBe(original);
  });

  it('returns a body-less response untouched', async () => {
    const original = new Response(null, {
      status: 204,
      headers: {'content-type': 'text/event-stream'},
    });
    const baseFetch = vi.fn().mockResolvedValue(original);

    const response = await withStreamIdleTimeout(
      IDLE_TIMEOUT_MS,
      baseFetch,
    )('http://test-url');

    expect(response).toBe(original);
  });

  it('forwards the url and init to the supplied base fetch', async () => {
    const baseFetch = vi.fn().mockResolvedValue(new Response('{}'));
    const init = {method: 'DELETE'};

    await withStreamIdleTimeout(IDLE_TIMEOUT_MS, baseFetch)(
      'http://test-url',
      init,
    );

    expect(baseFetch).toHaveBeenCalledWith('http://test-url', init);
  });

  it('falls back to the global fetch when no base fetch is supplied', async () => {
    const globalFetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', globalFetch);

    await withStreamIdleTimeout(IDLE_TIMEOUT_MS)('http://test-url');

    expect(globalFetch).toHaveBeenCalledWith('http://test-url', undefined);
  });
});
