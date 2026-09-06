/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves after `ms` milliseconds.
 *
 * It uses the global `setTimeout` rather than `node:timers/promises` so that a
 * test can drive it with a fake timer.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
