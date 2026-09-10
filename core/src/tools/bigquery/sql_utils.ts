/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQL injection defences for the BigQuery ML tools.
 *
 * The BigQuery ML tools build their SQL by interpolation, because a table
 * name, a column name and a `CREATE MODEL` option cannot be a query
 * parameter. The model chooses those values, so they are attacker-influenced
 * and every one of them passes through a check here first.
 *
 * Ported from `_escape_single_quotes`, `_is_valid_table_identifier` and
 * `_is_valid_column_identifier` in adk-python
 * `src/google/adk/integrations/bigquery/query_tool.py` (branch `main`).
 */

/** Characters a BigQuery table identifier may contain. */
const TABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** Characters a BigQuery column identifier may contain. */
const COLUMN_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Escapes a string so that it cannot break out of a SQL string literal.
 *
 * The backslash is escaped first, so that a trailing backslash cannot consume
 * the escape of the closing quote.
 *
 * @param value The text to place inside `'...'`.
 * @return The escaped text.
 */
export function escapeSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Whether a string is safe to interpolate as a BigQuery table identifier.
 *
 * A table identifier may name a project, a dataset and a table, so a dot and
 * a colon are allowed. `my_table; DROP TABLE users;` is not.
 *
 * @param name The candidate identifier.
 * @return True when it is safe.
 */
export function isValidTableIdentifier(name: string): boolean {
  return TABLE_IDENTIFIER_PATTERN.test(name);
}

/**
 * Whether a string is safe to interpolate as a BigQuery column identifier.
 *
 * Neither a dot nor a colon is allowed: a column name never needs one, and
 * refusing them keeps a qualified name out of a position that expects a bare
 * column.
 *
 * @param name The candidate identifier.
 * @return True when it is safe.
 */
export function isValidColumnIdentifier(name: string): boolean {
  return COLUMN_IDENTIFIER_PATTERN.test(name);
}

/**
 * Builds the message a tool returns for a rejected identifier.
 *
 * @param name The identifier that was rejected.
 * @return The message, matching adk-python's wording.
 */
export function invalidIdentifierMessage(name: string): string {
  return `Invalid BigQuery identifier: ${name}`;
}

/**
 * Whether a data source argument is a query rather than a table name.
 *
 * The BigQuery ML tools accept either, and read it as a query when it starts
 * with `SELECT` or `WITH`, ignoring leading space and case.
 *
 * @param source The `history_data`, `input_data` or `target_data` argument.
 * @return True when the argument is a query.
 */
export function isSubquery(source: string): boolean {
  const trimmed = source.trim().toUpperCase();
  return trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');
}

/**
 * Renders a list of identifiers as a BigQuery array literal.
 *
 * @param identifiers Identifiers already checked by
 *     {@link isValidColumnIdentifier}.
 * @return The array literal, e.g. `['a', 'b']`.
 */
export function toIdentifierArrayLiteral(
  identifiers: readonly string[],
): string {
  return `[${identifiers.map((column) => `'${column}'`).join(', ')}]`;
}
