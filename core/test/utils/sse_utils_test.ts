/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {readSseData} from '../../src/utils/sse_utils.js';

/** Records whether the consumer cancelled the stream. */
interface TrackedStream {
  stream: ReadableStream<Uint8Array>;
  wasCancelled: () => boolean;
}

/** Builds a stream that emits each string as one network chunk. */
function streamOf(chunks: string[]): TrackedStream {
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
  return {stream, wasCancelled: () => cancelled};
}

/** Collects every payload the reader yields. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const payloads: string[] = [];
  for await (const payload of readSseData(stream)) {
    payloads.push(payload);
  }
  return payloads;
}

describe('readSseData', () => {
  it('yields two payloads delivered in one network chunk, in order', async () => {
    const {stream} = streamOf(['data: one\ndata: two\n']);

    expect(await collect(stream)).toEqual(['one', 'two']);
  });

  it('reassembles a payload split across two network chunks', async () => {
    const {stream} = streamOf(['data: {"a":', ' 1}\n']);

    expect(await collect(stream)).toEqual(['{"a": 1}']);
  });

  it('stops at [DONE] and drops the bytes after it', async () => {
    const {stream} = streamOf(['data: one\n', 'data: [DONE]\n', 'data: two\n']);

    expect(await collect(stream)).toEqual(['one']);
  });

  it('skips blank lines, comments and non-data fields', async () => {
    const {stream} = streamOf([
      '\n',
      ': keep-alive\n',
      'event: message\n',
      'data:\n',
      'data: one\n',
    ]);

    expect(await collect(stream)).toEqual(['one']);
  });

  it('yields a trailing payload that has no final newline', async () => {
    const {stream} = streamOf(['data: one\n', 'data: last']);

    expect(await collect(stream)).toEqual(['one', 'last']);
  });

  it('ignores a trailing [DONE] that has no final newline', async () => {
    const {stream} = streamOf(['data: one\n', 'data: [DONE]']);

    expect(await collect(stream)).toEqual(['one']);
  });

  it('releases the reader and cancels the stream when the consumer breaks', async () => {
    const {stream, wasCancelled} = streamOf([
      'data: one\n',
      'data: two\n',
      'data: three\n',
    ]);

    const seen: string[] = [];
    for await (const payload of readSseData(stream)) {
      seen.push(payload);
      break;
    }

    expect(seen).toEqual(['one']);
    expect(wasCancelled()).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it('releases the reader after full consumption', async () => {
    const {stream, wasCancelled} = streamOf(['data: one\n']);

    expect(await collect(stream)).toEqual(['one']);
    expect(stream.locked).toBe(false);
    // A stream that closed on its own needs no cancellation.
    expect(wasCancelled()).toBe(false);
  });

  it('releases the reader when the consumer throws', async () => {
    const {stream, wasCancelled} = streamOf(['data: one\n', 'data: two\n']);

    await expect(
      (async () => {
        for await (const payload of readSseData(stream)) {
          throw new Error(`consumer failed on ${payload}`);
        }
      })(),
    ).rejects.toThrow('consumer failed on one');

    expect(wasCancelled()).toBe(true);
    expect(stream.locked).toBe(false);
  });
});
