/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {readSseData} from '../../src/utils/sse_utils.js';

const encoder = new TextEncoder();

/** A stream that emits `chunks` verbatim and then closes. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** A stream that emits `chunks` and then stays open forever. */
function stallingStreamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
    },
  });
}

async function collect(
  events: AsyncGenerator<string, void>,
): Promise<string[]> {
  const received: string[] = [];
  for await (const event of events) {
    received.push(event);
  }
  return received;
}

describe('readSseData', () => {
  it('joins an event split across two chunks', async () => {
    const stream = streamOf('data: {"a"', ':1}\n\n');

    expect(await collect(readSseData(stream))).toEqual(['{"a":1}']);
  });

  it('yields every event of a chunk that holds several', async () => {
    const stream = streamOf('data: one\n\ndata: two\n\ndata: three\n\n');

    expect(await collect(readSseData(stream))).toEqual(['one', 'two', 'three']);
  });

  it('strips only the single space that follows the field name', async () => {
    const stream = streamOf('data:tight\ndata:  padded\n');

    expect(await collect(readSseData(stream))).toEqual(['tight', ' padded']);
  });

  it('ignores blank lines, comments and other fields', async () => {
    const stream = streamOf(
      ': keep-alive\n\nevent: message\nid: 7\nretry: 100\ndata: only\n\n',
    );

    expect(await collect(readSseData(stream))).toEqual(['only']);
  });

  it('yields a last event that has no trailing newline', async () => {
    const stream = streamOf('data: first\ndata: last');

    expect(await collect(readSseData(stream))).toEqual(['first', 'last']);
  });

  it('accepts carriage-return line endings', async () => {
    const stream = streamOf('data: one\r\n\r\ndata: two\r\n\r\n');

    expect(await collect(readSseData(stream))).toEqual(['one', 'two']);
  });

  it('releases the reader once the stream ends', async () => {
    const stream = streamOf('data: one\n\n');

    await collect(readSseData(stream));

    expect(stream.locked).toBe(false);
  });

  it('yields nothing when the signal is already aborted', async () => {
    const stream = stallingStreamOf('data: one\n\n');
    const controller = new AbortController();
    controller.abort();

    expect(await collect(readSseData(stream, controller.signal))).toEqual([]);
    expect(stream.locked).toBe(false);
  });

  it('stops at the next event when the consumer aborts', async () => {
    const stream = stallingStreamOf('data: one\n\ndata: two\n\n');
    const controller = new AbortController();
    const received: string[] = [];

    for await (const event of readSseData(stream, controller.signal)) {
      received.push(event);
      controller.abort();
    }

    expect(received).toEqual(['one', 'two']);
    expect(stream.locked).toBe(false);
  });

  it('ends a read that is still in flight when the signal fires', async () => {
    const stream = stallingStreamOf();
    const controller = new AbortController();

    const events = collect(readSseData(stream, controller.signal));
    controller.abort();

    expect(await events).toEqual([]);
    expect(stream.locked).toBe(false);
  });

  it('drops a partial trailing event when the signal fires', async () => {
    const stream = stallingStreamOf('data: whole\n', 'data: partia');
    const controller = new AbortController();
    const received: string[] = [];

    for await (const event of readSseData(stream, controller.signal)) {
      received.push(event);
      controller.abort();
    }

    expect(received).toEqual(['whole']);
    expect(stream.locked).toBe(false);
  });

  it('reports a stream failure and still releases the reader', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('ECONNRESET'));
      },
    });

    await expect(collect(readSseData(stream))).rejects.toThrow('ECONNRESET');
    expect(stream.locked).toBe(false);
  });

  it('leaves no unhandled rejection when an abort races a stream failure', async () => {
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      let failStream!: (error: Error) => void;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          failStream = (error) => controller.error(error);
          controller.enqueue(encoder.encode('data: one\n\n'));
        },
      });
      const controller = new AbortController();
      const received: string[] = [];

      for await (const event of readSseData(stream, controller.signal)) {
        received.push(event);
        failStream(new Error('ECONNRESET'));
        controller.abort();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(received).toEqual(['one']);
      expect(rejections).toEqual([]);
      expect(stream.locked).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('releases the reader when the consumer breaks out early', async () => {
    const stream = streamOf('data: one\n\ndata: two\n\n');
    const received: string[] = [];

    for await (const event of readSseData(stream)) {
      received.push(event);
      break;
    }

    expect(received).toEqual(['one']);
    expect(stream.locked).toBe(false);
  });
});
