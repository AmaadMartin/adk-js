/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves after `ms` milliseconds.
 *
 * Uses the global `setTimeout` rather than the one in `node:timers/promises`
 * so a test can drive it with fake timers, which patch the global only.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
