/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WebSocket close codes a live model connection reports.
 *
 * The live flow reads the code to choose between a reconnect, a clean end of
 * the stream, and a failure.
 */
export enum LiveCloseCode {
  /** The peer ended the session on purpose. Nothing was lost. */
  NORMAL = 1000,
  /** The connection dropped without a close frame. */
  ABNORMAL = 1006,
  /** The server hit an unexpected condition. */
  INTERNAL = 1011,
  /** The server is restarting. */
  SERVICE_RESTART = 1012,
}

const LIVE_CONNECTION_CLOSED_ERROR_SYMBOL = Symbol.for(
  'google.adk.liveConnectionClosedError',
);

/**
 * Type guard for {@link LiveConnectionClosedError}.
 *
 * @param err The value to check.
 * @returns True when the value is a live connection close error.
 */
export function isLiveConnectionClosedError(
  err: unknown,
): err is LiveConnectionClosedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    LIVE_CONNECTION_CLOSED_ERROR_SYMBOL in err &&
    err[LIVE_CONNECTION_CLOSED_ERROR_SYMBOL] === true
  );
}

/**
 * Raised when a live model connection closes without the caller asking for it.
 *
 * A teardown the caller started closes the stream quietly instead.
 */
export class LiveConnectionClosedError extends Error {
  readonly [LIVE_CONNECTION_CLOSED_ERROR_SYMBOL] = true;

  constructor(
    readonly code: LiveCloseCode | number,
    readonly reason?: string,
  ) {
    super(`live connection closed (${code})${reason ? `: ${reason}` : ''}`);
    this.name = 'LiveConnectionClosedError';
  }
}
