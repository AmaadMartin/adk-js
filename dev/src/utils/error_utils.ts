/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an arbitrary value to an indexable record, or `undefined` when it is
 * not a non-null object. Lets duck-typed shapes such as an error carrying a
 * numeric `status` be inspected without widening to `any`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Returns the message of a thrown value: the `message` of an `Error`, and the
 * string form of anything else. Never throws.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns the class name of a thrown value — `Error`, `TypeError`, and so on —
 * or its `typeof` when it is not an `Error`.
 *
 * Use it in place of {@link errorMessage} where the message cannot be trusted
 * with the log. A library is free to build its caller's input into a message,
 * so an error raised while handling a credential can carry that credential;
 * `name` is a fixed class identifier and carries no input.
 */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
