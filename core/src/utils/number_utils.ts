/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Throws when `value` is below `min`. A field left unset passes.
 *
 * The config factories in ADK mirror pydantic field bounds from
 * `google/adk-python`, which reject an out-of-range value at construction
 * time rather than letting it reach the service that uses it.
 *
 * @param name The field name, used in the error message.
 * @param value The value to check, or `undefined` for a field left unset.
 * @param min The smallest value the field accepts.
 * @throws {Error} When `value` is below `min`.
 */
export function requireAtLeast(
  name: string,
  value: number | undefined,
  min: number,
): void {
  if (value !== undefined && value < min) {
    throw new Error(`${name} must be at least ${min}.`);
  }
}
