/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether the value is a plain object whose fields can be read by name.
 *
 * An array is not one: it is an object at runtime, but code that reads a named
 * field from it is almost always looking at the wrong value.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value when it is a string with content, and undefined otherwise. */
export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
