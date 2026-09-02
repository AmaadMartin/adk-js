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

/**
 * Type guard for {@link LiveConnectionClosedError}.
 *
 * Matches on `name` rather than `instanceof <subclass>` so it stays correct
 * when errors cross a package boundary (two copies of adk-js in one runtime
 * would fail an `instanceof` check between them).
 *
 * @param err The value to check.
 * @returns True when the value is a live connection close error.
 */
export function isLiveConnectionClosedError(
  err: unknown,
): err is LiveConnectionClosedError {
  return err instanceof Error && err.name === 'LiveConnectionClosedError';
}

/**
 * Raised when a live model connection closes without the caller asking for it.
 *
 * A teardown the caller started closes the stream quietly instead.
 */
export class LiveConnectionClosedError extends Error {
  constructor(
    readonly code: LiveCloseCode | number,
    readonly reason?: string,
  ) {
    super(`live connection closed (${code})${reason ? `: ${reason}` : ''}`);
    this.name = 'LiveConnectionClosedError';
  }
}
