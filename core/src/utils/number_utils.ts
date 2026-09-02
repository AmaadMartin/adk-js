/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Throws when `value` is below `min`.
 *
 * The config factories in ADK mirror pydantic field bounds from
 * `google/adk-python`, which reject an out-of-range value at construction
 * time rather than letting it reach the service that uses it.
 *
 * @param name The field name, used in the error message.
 * @param value The value to check.
 * @param min The smallest value the field accepts.
 * @throws {Error} When `value` is below `min`.
 */
export function requireAtLeast(name: string, value: number, min: number): void {
  if (value < min) {
    throw new Error(`${name} must be at least ${min}.`);
  }
}
