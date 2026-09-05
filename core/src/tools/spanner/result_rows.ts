/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Snapshot} from '@google-cloud/spanner';
import {inspect} from 'node:util';

/**
 * Runs a statement on a snapshot and turns the rows it yields into values a
 * tool can put in front of a model.
 */

/**
 * A statement and its parameters. `@google-cloud/spanner` declares this as
 * `ExecuteSqlRequest` but does not export the name from its entry point.
 */
export type SpannerQuery = Exclude<Parameters<Snapshot['run']>[0], string>;

/**
 * Runs `query` and reads each row as the list of its column values.
 *
 * @param snapshot The read-only snapshot to run against.
 * @param query The statement and its parameters.
 * @return One array of column values per row.
 */
export async function selectValueRows(
  snapshot: Snapshot,
  query: SpannerQuery,
): Promise<unknown[][]> {
  const [rows] = await snapshot.run(query);
  return rows.map(toValueRow);
}

/**
 * Runs `query` and reads each row as an object keyed by column name.
 *
 * The client labels every value with the column it came from, so a caller
 * that wants the names does not have to restate the `SELECT` list and risk
 * the two drifting apart.
 *
 * @param snapshot The read-only snapshot to run against.
 * @param query The statement and its parameters.
 * @return One object per row, keyed by column name.
 */
export async function selectNamedRows(
  snapshot: Snapshot,
  query: SpannerQuery,
): Promise<Array<Record<string, unknown>>> {
  const [rows] = await snapshot.run(query);
  return rows.map(toNamedRow);
}

/**
 * One row of a Spanner result set: an array of `{name, value}` fields, or an
 * object keyed by column name when the request asked for `json`.
 * `@google-cloud/spanner` declares both shapes but exports neither by name
 * from its entry point, so they are described structurally here.
 */
export type SpannerRow =
  | Array<{name: string; value: unknown}>
  | Record<string, unknown>;

/**
 * Reads one row as the list of its column values.
 *
 * @param row One row of a result set.
 * @return The column values, in the order the query selected them.
 */
export function toValueRow(row: SpannerRow): unknown[] {
  return Array.isArray(row)
    ? row.map((field) => field.value)
    : Object.values(row);
}

/**
 * Reads one row as an object keyed by column name.
 *
 * @param row One row of a result set.
 * @return The row's values, keyed by the column each came from.
 */
export function toNamedRow(row: SpannerRow): Record<string, unknown> {
  return Array.isArray(row)
    ? Object.fromEntries(row.map((field) => [field.name, field.value]))
    : row;
}

/**
 * Serializes one row the way adk-python does: the row itself when it survives
 * JSON serialization, and a readable rendering of it when it does not.
 *
 * The Spanner client returns `BigInt` and `Buffer` values for the numeric and
 * byte column types, and `JSON.stringify` throws on a `BigInt`, so this path
 * runs against real data rather than only in theory. adk-python falls back to
 * `str(row)`; `inspect` is used here because `String({a: 1n})` is
 * `[object Object]` and would discard the row.
 *
 * @param row One row of a result set.
 * @return The row, or a rendering of it when it cannot be serialized.
 */
export function toJsonSafe(row: unknown): unknown {
  try {
    JSON.stringify(row);
    return row;
  } catch {
    return inspect(row);
  }
}
