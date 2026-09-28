/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Milliseconds per second. */
const MILLIS_PER_SECOND = 1000;

/** Returns the current time in seconds since the epoch, as ADK records it. */
export function nowInSeconds(): number {
  return Date.now() / MILLIS_PER_SECOND;
}
