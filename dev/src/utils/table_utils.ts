/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The string between two columns. */
const COLUMN_SEPARATOR = ' | ';

/**
 * Renders `rows` as an aligned plain-text table, header row first.
 *
 * Column widths come from the content, so a cell wider than its header does
 * not push the later columns out of line. The returned lines are the header,
 * a rule as wide as the header, then one line per body row. An empty `rows`
 * renders nothing.
 */
export function formatAlignedTable(rows: string[][]): string[] {
  if (rows.length === 0) {
    return [];
  }

  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((cells) => cells[column].length)),
  );

  const [header, ...body] = rows.map((cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join(COLUMN_SEPARATOR),
  );

  return [header, '-'.repeat(header.length), ...body];
}
