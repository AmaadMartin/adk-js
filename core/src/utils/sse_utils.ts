/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Name and separator of the Server-Sent Events `data` field. */
const DATA_FIELD_PREFIX = 'data:';

/**
 * Yields the payload of every `data:` field in a Server-Sent Events stream.
 *
 * The stream is decoded as UTF-8 and buffered across chunk boundaries, so an
 * event split over several network chunks is still emitted once, whole. Blank
 * lines, comment (`:`) lines and every other SSE field are ignored. A payload
 * is emitted verbatim: interpreting a sentinel such as `[DONE]` is the
 * caller's protocol concern.
 *
 * The reader is released on every exit path: a clean end, an abort, an early
 * `break` by the consumer, and a stream that fails mid-body. Aborting also
 * cancels a read that is already in flight, so a stalled server cannot hold
 * the connection open. A stream failure reaches the caller as a rejection.
 *
 * @param stream The raw `text/event-stream` body.
 * @param abortSignal Stops the generator when it fires.
 */
export async function* readSseData(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<string, void> {
  const reader = stream.getReader();
  // A reader of a failed stream rejects `cancel()` with that failure, and both
  // call sites below have to discard it: the abort listener would leave the
  // rejection unhandled and end the process, and the cleanup would skip
  // `releaseLock()`. The caller still learns of the failure, because `read()`
  // rejects with it too.
  const cancel = () => reader.cancel().catch(() => undefined);
  const onAbort = () => void cancel();
  abortSignal?.addEventListener('abort', onAbort, {once: true});

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!abortSignal?.aborted) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline < 0) {
        continue;
      }
      const completeLines = buffer.slice(0, lastNewline);
      buffer = buffer.slice(lastNewline + 1);
      yield* dataFields(completeLines);
    }
    if (!abortSignal?.aborted) {
      // A last event that the server did not terminate with a newline.
      yield* dataFields(buffer);
    }
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    await cancel();
    reader.releaseLock();
  }
}

/**
 * Yields the payload of each `data:` line in a run of complete SSE lines.
 *
 * @param lines Newline-separated SSE lines, without a trailing newline.
 */
function* dataFields(lines: string): Generator<string, void> {
  for (const rawLine of lines.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith(DATA_FIELD_PREFIX)) {
      continue;
    }
    const payload = line.slice(DATA_FIELD_PREFIX.length);
    yield payload.startsWith(' ') ? payload.slice(1) : payload;
  }
}
