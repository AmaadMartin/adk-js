/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Narrows an arbitrary value to a keyed record.
 *
 * An array is rejected: it is an object, but a caller that reads named keys
 * off it wants a dictionary, not a list.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a field, or `undefined` when it is absent or not a string. */
export function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reads a field, or `undefined` when it is absent or not a number. */
export function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

/** Parses JSON, returning `undefined` rather than throwing on bad input. */
export function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
