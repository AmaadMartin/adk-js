/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** An abort controller and the teardown that detaches what feeds it. */
export interface LinkedAbort {
  controller: AbortController;
  /** Detaches the parent listener and clears the deadline. */
  dispose: () => void;
}

/**
 * Creates an `AbortController` that aborts when the parent signal does, or
 * when `timeoutMs` elapses.
 *
 * The caller must call `dispose` on every exit path: it removes the parent
 * listener and clears the timer, which would otherwise keep the process alive
 * and leak one listener per call.
 *
 * @param parentSignal - Signal to follow, if any.
 * @param timeoutMs - Deadline in milliseconds, if any.
 */
export function createLinkedAbort(
  parentSignal?: AbortSignal,
  timeoutMs?: number,
): LinkedAbort {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };

  const timer =
    timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  const clearTimer = () => {
    clearTimeout(timer);
  };

  if (!parentSignal) {
    return {controller, dispose: clearTimer};
  }
  if (parentSignal.aborted) {
    abort();
    return {controller, dispose: clearTimer};
  }
  parentSignal.addEventListener('abort', abort, {once: true});
  return {
    controller,
    dispose: () => {
      clearTimer();
      parentSignal.removeEventListener('abort', abort);
    },
  };
}
