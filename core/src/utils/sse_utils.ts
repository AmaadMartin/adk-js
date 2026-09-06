/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Field prefix that marks a server-sent event payload line. */
const SSE_DATA_PREFIX = 'data:';

/** Payload that terminates an OpenAI-style server-sent event stream. */
const SSE_DONE_PAYLOAD = '[DONE]';

/**
 * Reads the `data:` payloads of a server-sent event stream, in order.
 *
 * Payloads are yielded as raw strings; the caller decides how to parse them.
 * Comment lines (`: keep-alive`), blank lines and other fields (`event:`,
 * `id:`) are skipped, and a payload split across two network chunks is
 * reassembled. Iteration ends at the first `data: [DONE]` sentinel, so bytes
 * after it are never yielded.
 *
 * The stream reader is released and the stream is cancelled on every exit
 * path, including a `break` by the consumer, so an abandoned response does not
 * hold its connection open.
 */
export async function* readSseData(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const result = await reader.read();
      // A closing stream flushes any line that arrived without a newline.
      buffer += result.done
        ? '\n'
        : decoder.decode(result.value, {stream: true});

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const payload = parseDataLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (payload === SSE_DONE_PAYLOAD) {
          return;
        }
        if (payload !== undefined) {
          yield payload;
        }
        newline = buffer.indexOf('\n');
      }

      if (result.done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
    await stream.cancel();
  }
}

/**
 * Extracts the payload of a single `data:` line, or `undefined` when the line
 * carries no payload.
 */
function parseDataLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(SSE_DATA_PREFIX)) {
    return undefined;
  }
  const payload = trimmed.slice(SSE_DATA_PREFIX.length).trim();
  return payload === '' ? undefined : payload;
}
