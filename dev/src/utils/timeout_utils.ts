/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs `body` under a deadline and reports whether the deadline was reached.
 *
 * The deadline aborts the signal handed to `body` rather than abandoning it, so
 * the work behind the signal stops instead of running on unobserved. A body
 * that ends because of that abort resolves to `true`; any other failure is
 * rethrown.
 *
 * @param timeoutMs The deadline in milliseconds, or undefined for no deadline.
 * @param body The work to run, which must honour the signal it is given.
 * @return True when the deadline aborted the work.
 */
export async function runWithTimeout(
  timeoutMs: number | undefined,
  body: (signal: AbortSignal) => Promise<void>,
): Promise<boolean> {
  const controller = new AbortController();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), timeoutMs);

  try {
    await body(controller.signal);
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }

  return controller.signal.aborted;
}
