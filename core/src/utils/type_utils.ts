/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrowing guards for values whose shape the compiler cannot know: a parsed
 * payload, a duck-typed error, a metadata block a remote server populated.
 *
 * Each one is a type predicate, so a caller narrows the value instead of
 * asserting the checker is wrong.
 */

/** Whether the value is a non-null object, and so safe to index. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether the value is an array holding only strings. */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
  );
}
