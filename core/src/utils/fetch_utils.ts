/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The init argument of the global `fetch`. */
type FetchInit = Parameters<typeof fetch>[1];

/** Structural form of `fetch`, so callers need no DOM/undici import. */
export type FetchFn = (
  url: string | URL,
  init?: FetchInit,
) => Promise<Response>;

const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

/**
 * Marks "the idle budget expired first" in the read race. The race resolves
 * rather than rejects, so a timer that fires after a chunk arrived never
 * leaves a rejected promise behind.
 */
const IDLE = Symbol('idle');

/**
 * Re-emits `source`, failing the stream when no chunk arrives for
 * `idleTimeoutMs`. The budget restarts on every chunk, so a stream that keeps
 * producing data runs for as long as it likes.
 */
export function idleTimeoutStream(
  source: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearIdleTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleTimeoutMs);
      });

      try {
        const result = await Promise.race([reader.read(), idle]);
        if (result === IDLE) {
          throw new Error(`Stream idle for more than ${idleTimeoutMs} ms`);
        }
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (err) {
        await reader.cancel(err);
        controller.error(err);
      } finally {
        clearIdleTimer();
      }
    },
    async cancel(reason) {
      clearIdleTimer();
      await reader.cancel(reason);
    },
  });
}

/**
 * Wraps `baseFetch` (default: the global `fetch`) so that an event-stream
 * response body fails once it stays silent for `idleTimeoutMs`. Any other
 * response is returned untouched.
 */
export function withStreamIdleTimeout(
  idleTimeoutMs: number,
  baseFetch?: FetchFn,
): FetchFn {
  return async (url, init) => {
    const response = await (baseFetch ?? fetch)(url, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || !contentType.includes(EVENT_STREAM_CONTENT_TYPE)) {
      return response;
    }

    return new Response(idleTimeoutStream(response.body, idleTimeoutMs), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
