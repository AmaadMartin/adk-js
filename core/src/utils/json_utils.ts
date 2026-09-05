/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Written wherever a value cannot be represented. */
export const NOT_SERIALIZABLE = '<not serializable>';

/**
 * Serializes a value to compact JSON, or to {@link NOT_SERIALIZABLE}.
 *
 * `JSON.stringify` produces no whitespace and does not escape non-ASCII, which
 * matches the compact form the OpenTelemetry attribute values use. It throws on
 * a cycle or a `BigInt`, and returns `undefined` for a value it drops, such as
 * `undefined` itself or a function.
 */
export function safeJsonSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? NOT_SERIALIZABLE;
  } catch {
    return NOT_SERIALIZABLE;
  }
}
