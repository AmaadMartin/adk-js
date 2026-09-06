/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {inspect} from 'node:util';

/**
 * Conversions from the rows `@google-cloud/spanner` returns to the plain
 * values the Spanner tools hand to the model.
 *
 * The SDK types every column value as `any`, so these functions are the one
 * place that widens it to `unknown`.
 */

/** One column of a positional row: the SDK's `Field`, with a checked value. */
export interface SpannerField {
  name: string;
  value: unknown;
}

/**
 * A row `Database.run` yields: positional fields by default, or an object
 * keyed by column name when the query asked for JSON.
 *
 * `@google-cloud/spanner` does not export its `Row` and `Json` types from the
 * package root, so this is the structural equivalent. The compiler still
 * checks it against what the SDK returns at every call site.
 */
export type SpannerRow = SpannerField[] | Record<string, unknown>;

/** Returns a row's column values, in the order the query selected them. */
export function rowValues(row: SpannerRow): unknown[] {
  return Array.isArray(row)
    ? row.map((field) => field.value)
    : Object.values(row);
}

/** Returns a row keyed by column name. */
export function rowObject(row: SpannerRow): Record<string, unknown> {
  if (!Array.isArray(row)) {
    return {...row};
  }
  return Object.fromEntries(row.map((field) => [field.name, field.value]));
}

/**
 * Returns `value` when it survives JSON serialization, and a readable
 * rendering of it when it does not, so one unserializable row cannot fail the
 * whole call.
 */
export function toSerializable(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return inspect(value, {breakLength: Infinity, depth: null});
  }
}
