/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renders rows of data as a fixed-column text table, for reports a person
 * reads in a terminal.
 */

/** Cells wider than this are cut short, so the columns stay aligned. */
const MAX_CELL_WIDTH = 25;

/** Marks a cell that was cut short. */
const ELLIPSIS = '...';

/** Flattens and shortens one cell. */
function toCell(value: unknown): string {
  const text = (value === undefined || value === null ? '' : String(value))
    .replaceAll('\n', ' ')
    .trim();
  return text.length > MAX_CELL_WIDTH
    ? text.slice(0, MAX_CELL_WIDTH - ELLIPSIS.length) + ELLIPSIS
    : text;
}

/**
 * Renders rows as a table with a header, a rule and one line per row.
 *
 * Line breaks inside a cell become spaces, because a cell that spans lines
 * breaks the alignment that makes the table readable.
 *
 * @param rows The rows to render. A column a row does not have is empty.
 * @param columns The columns to render, in order.
 * @return The table, with no trailing line break.
 */
export function formatTable(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
): string {
  const cells = rows.map((row) => columns.map((column) => toCell(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => row[index].length)),
  );
  const line = (values: readonly string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...cells.map(line),
  ].join('\n');
}
