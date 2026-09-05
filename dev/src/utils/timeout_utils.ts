/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const TIMEOUT_PATTERN = /^(\d+)([sm])?$/;
const SECONDS_PER_MINUTE = 60;
const MILLIS_PER_SECOND = 1000;

/** Raised by {@link withTimeout} when the budget runs out. */
export class TimeoutError extends Error {
  constructor(message = 'Timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Parses a timeout such as `30`, `30s` or `5m` into seconds.
 *
 * @throws when the value is not a whole number of seconds or minutes.
 */
export function parseTimeout(value: string): number {
  const match = TIMEOUT_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid timeout format: ${value}`);
  }
  const seconds = Number(match[1]);
  return match[2] === 'm' ? seconds * SECONDS_PER_MINUTE : seconds;
}

/**
 * Rejects with a {@link TimeoutError} when the promise takes longer than
 * `seconds`.
 *
 * The underlying work is not cancelled, because a promise cannot be; the
 * caller stops waiting for it.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  seconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError()),
          seconds * MILLIS_PER_SECOND,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
