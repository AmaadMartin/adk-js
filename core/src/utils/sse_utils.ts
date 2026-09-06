/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decoder for `text/event-stream` bodies.
 *
 * Several model providers stream their responses as server-sent events over a
 * plain `ReadableStream<Uint8Array>`, leaving the caller to reassemble the
 * frames. This module does that reassembly and nothing else: it hands back the
 * `data` payload of each frame as a string, and leaves the meaning of that
 * payload — JSON, a sentinel such as `[DONE]`, anything else — to the caller.
 */

/**
 * Appended when the body ends, so that a frame the server left unterminated
 * still dispatches.
 */
const FRAME_TERMINATOR = '\n\n';

/**
 * Returns the value of `line` when it is a `data` field, or `undefined` for a
 * comment line and for every other field (`event`, `id`, `retry`).
 *
 * A single leading space after the colon is part of the framing rather than
 * part of the value, so it is removed.
 */
function dataFieldValue(line: string): string | undefined {
  if (line.startsWith(':')) {
    return undefined;
  }
  const colon = line.indexOf(':');
  if (colon === -1) {
    return line === 'data' ? '' : undefined;
  }
  if (line.slice(0, colon) !== 'data') {
    return undefined;
  }
  const value = line.slice(colon + 1);
  return value.startsWith(' ') ? value.slice(1) : value;
}

/**
 * Yields the payload of every frame that `lines` completes.
 *
 * `pending` carries the `data` values seen so far across calls, because a frame
 * can span more than one read of the underlying stream.
 */
function* completedFrames(
  lines: string[],
  pending: string[],
): Generator<string, void> {
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line !== '') {
      const value = dataFieldValue(line);
      if (value !== undefined) {
        pending.push(value);
      }
      continue;
    }
    if (pending.length > 0) {
      yield pending.join('\n');
      pending.length = 0;
    }
  }
}

/**
 * Reads `stream` as server-sent events and yields the `data` payload of each
 * frame.
 *
 * Frames split across chunk boundaries are reassembled, `\r\n` and `\n` are
 * both accepted as line terminators, comment lines and non-`data` fields are
 * ignored, and the several `data:` lines of one frame are joined with `\n`.
 *
 * The reader is released and the stream cancelled when iteration finishes, and
 * also when the caller stops early or the stream throws.
 *
 * ```ts
 * for await (const data of readSseData(body)) {
 *   if (data === '[DONE]') break;
 *   handle(JSON.parse(data));
 * }
 * ```
 *
 * @param stream The response body to decode.
 * @return The `data` payload of each frame, in order.
 */
export async function* readSseData(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const pending: string[] = [];
  let buffer = '';
  try {
    for (;;) {
      const result = await reader.read();
      const chunk = result.done
        ? decoder.decode() + FRAME_TERMINATOR
        : decoder.decode(result.value, {stream: true});
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop() ?? '';
      yield* completedFrames(lines, pending);
      if (result.done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
    await stream.cancel();
  }
}
