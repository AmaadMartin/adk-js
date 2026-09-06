/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readSseData} from '@google/adk/utils/sse_utils.js';
import {describe, expect, it} from 'vitest';

/** A stream that records whether it was cancelled, one enqueue per chunk. */
function streamOf(chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {stream, cancelled: () => cancelled};
}

/** Drains a decoder into an array. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const frames: string[] = [];
  for await (const data of readSseData(stream)) {
    frames.push(data);
  }
  return frames;
}

describe('readSseData', () => {
  it('yields the data payload of each frame', async () => {
    const {stream} = streamOf(['data: one\n\ndata: two\n\n']);
    expect(await drain(stream)).toEqual(['one', 'two']);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const {stream} = streamOf(['data: hel', 'lo wor', 'ld\n\n']);
    expect(await drain(stream)).toEqual(['hello world']);
  });

  it('splits a frame that arrives in the middle of a chunk', async () => {
    const {stream} = streamOf(['data: one\n\ndata: tw', 'o\n\n']);
    expect(await drain(stream)).toEqual(['one', 'two']);
  });

  it('accepts CRLF framing', async () => {
    const {stream} = streamOf(['data: one\r\n\r\ndata: two\r\n\r\n']);
    expect(await drain(stream)).toEqual(['one', 'two']);
  });

  it('accepts a CRLF split across chunk boundaries', async () => {
    const {stream} = streamOf(['data: one\r', '\n\r', '\n']);
    expect(await drain(stream)).toEqual(['one']);
  });

  it('ignores comment lines', async () => {
    const {stream} = streamOf([': keep-alive\ndata: one\n\n']);
    expect(await drain(stream)).toEqual(['one']);
  });

  it('ignores fields other than data', async () => {
    const {stream} = streamOf(['event: message\nid: 7\ndata: one\n\n']);
    expect(await drain(stream)).toEqual(['one']);
  });

  it('joins several data lines of one frame with a newline', async () => {
    const {stream} = streamOf(['data: first\ndata: second\n\n']);
    expect(await drain(stream)).toEqual(['first\nsecond']);
  });

  it('reads a bare data field as an empty payload', async () => {
    const {stream} = streamOf(['data\ndata: tail\n\n']);
    expect(await drain(stream)).toEqual(['\ntail']);
  });

  it('ignores a bare field name that is not data', async () => {
    const {stream} = streamOf(['retry\ndata: one\n\n']);
    expect(await drain(stream)).toEqual(['one']);
  });

  it('keeps a payload that has no space after the colon', async () => {
    const {stream} = streamOf(['data:tight\n\n']);
    expect(await drain(stream)).toEqual(['tight']);
  });

  it('strips only the first space after the colon', async () => {
    const {stream} = streamOf(['data:  padded\n\n']);
    expect(await drain(stream)).toEqual([' padded']);
  });

  it('yields a final frame the server left unterminated', async () => {
    const {stream} = streamOf(['data: tail']);
    expect(await drain(stream)).toEqual(['tail']);
  });

  it('yields nothing for an empty body', async () => {
    const {stream} = streamOf([]);
    expect(await drain(stream)).toEqual([]);
  });

  it('yields nothing for a body of blank lines', async () => {
    const {stream} = streamOf(['\n\n\n']);
    expect(await drain(stream)).toEqual([]);
  });

  it('decodes a multi-byte character split across chunk boundaries', async () => {
    const encoded = new TextEncoder().encode('data: né\n\n');
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 8));
        controller.enqueue(encoded.slice(8));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await drain(stream)).toEqual(['né']);
    expect(cancelled).toBe(false);
  });

  it('releases the reader when the body ends', async () => {
    const {stream} = streamOf(['data: one\n\n']);
    await drain(stream);
    expect(stream.locked).toBe(false);
  });

  it('releases the reader and cancels the stream when the caller stops early', async () => {
    // The stream never closes, so a caller that stops reading leaks it unless
    // the decoder cancels it.
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('data: tick\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const data of readSseData(stream)) {
      expect(data).toBe('tick');
      break;
    }
    expect(stream.locked).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('releases the reader when the body errors', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('the connection dropped'));
      },
    });
    await expect(drain(stream)).rejects.toThrow('the connection dropped');
    expect(stream.locked).toBe(false);
  });
});
