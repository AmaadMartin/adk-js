/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Waits for `promise` to resolve, for at most `timeoutSeconds`.
 *
 * JavaScript cannot cancel a promise, so an expired wait abandons the promise
 * rather than stopping the work behind it. Use this where a caller must make
 * progress even though a dependency may never settle.
 *
 * @param promise The promise to wait for.
 * @param timeoutSeconds How long to wait, in seconds. A value of zero or less
 *     waits indefinitely.
 * @returns `true` when the promise resolved in time, `false` when the wait
 *     expired.
 * @throws Whatever `promise` rejects with, when it rejects before the wait
 *     expires.
 */
export function resolvesWithin(
  promise: Promise<unknown>,
  timeoutSeconds: number,
): Promise<boolean> {
  const resolved = promise.then(() => true);
  if (timeoutSeconds <= 0) {
    return resolved;
  }
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(
      () => resolve(false),
      timeoutSeconds * MILLISECONDS_PER_SECOND,
    );
  });
  return Promise.race([resolved, expiry]).finally(() => clearTimeout(timer));
}
