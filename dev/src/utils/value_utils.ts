/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Reads the message off anything a `catch (error: unknown)` can hand you. */
export function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrows to a plain object, so an array or null does not pass as one. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
