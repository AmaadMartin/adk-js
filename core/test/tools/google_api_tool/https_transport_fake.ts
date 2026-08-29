/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {PassThrough} from 'node:stream';
import {Mock, vi} from 'vitest';

/** What a faked `https.request` call should answer with. */
export interface FakeResponse {
  /** The HTTP status. Left out to fake a response that never reports one. */
  statusCode?: number;
  /** The response body. */
  body?: string;
  /** An error to emit on the response stream instead of ending it. */
  streamError?: Error;
}

/** The arguments the converter passes to `https.request`. */
export interface CapturedRequest {
  url: string;
  options: {agent?: unknown; headers?: Record<string, string>};
}

/** Makes a mocked `https.request` answer every call the same way. */
export function respondWith(requestMock: Mock, response: FakeResponse): void {
  requestMock.mockImplementation(
    (
      _url: string,
      _options: object,
      callback: (message: PassThrough & {statusCode?: number}) => void,
    ) => {
      const message = Object.assign(new PassThrough(), {
        statusCode: response.statusCode,
      });
      callback(message);
      if (response.streamError) {
        message.emit('error', response.streamError);
      } else {
        message.end(response.body ?? '');
      }
      return {on: vi.fn(), end: vi.fn()};
    },
  );
}

/** Makes a mocked `https.request` fail at the connection level. */
export function failRequestWith(requestMock: Mock, error: Error): void {
  requestMock.mockImplementation(() => {
    const listeners: Array<(error: Error) => void> = [];
    return {
      on: (event: string, listener: (error: Error) => void) => {
        if (event === 'error') {
          listeners.push(listener);
        }
      },
      end: () => {
        for (const listener of listeners) {
          listener(error);
        }
      },
    };
  });
}

/** Returns the URL and options of the single captured request. */
export function capturedRequest(requestMock: Mock): CapturedRequest {
  const [url, options] = requestMock.mock.calls[0] as [
    string,
    CapturedRequest['options'],
  ];
  return {url, options};
}
