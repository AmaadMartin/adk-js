/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves after `ms` milliseconds.
 *
 * This wraps the global `setTimeout` rather than re-exporting the one from
 * `node:timers/promises`, because Vitest's fake timers replace the global and
 * leave the module one alone: a test that advances fake timers over the module
 * version waits for real.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
