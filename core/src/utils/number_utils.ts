/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** An inclusive numeric range. `max` omitted means unbounded above. */
export interface NumberRange {
  min: number;
  max?: number;
}

/**
 * Throws when `value` falls outside `range`.
 *
 * The config factories in ADK mirror pydantic field bounds from
 * `google/adk-python`, which reject an out-of-range value at construction
 * time rather than letting it reach the service that uses it.
 *
 * @param name The field name, used in the error message.
 * @param value The value to check.
 * @param range The inclusive bounds the value must satisfy.
 */
export function requireInRange(
  name: string,
  value: number,
  range: NumberRange,
): void {
  if (value < range.min || (range.max !== undefined && value > range.max)) {
    throw new Error(
      range.max === undefined
        ? `${name} must be at least ${range.min}.`
        : `${name} must be between ${range.min} and ${range.max}.`,
    );
  }
}
