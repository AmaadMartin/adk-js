/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renders rows of data as a bordered plain-text table.
 *
 * The output is meant to be read in a terminal or a log file, so a cell that
 * is wider than the column limit is wrapped onto more lines rather than
 * truncated.
 */

/** Separates the wrapped lines of one cell. */
const LINE_BREAK = '\n';

/** Pads the text of a cell away from the column borders. */
const CELL_PADDING = ' ';

/** Splits a cell into lines no longer than `maxColWidth` characters. */
function wrapCell(text: string, maxColWidth: number): string[] {
  const lines: string[] = [];
  for (const line of text.split(LINE_BREAK)) {
    if (line.length <= maxColWidth) {
      lines.push(line);
      continue;
    }
    for (let start = 0; start < line.length; start += maxColWidth) {
      lines.push(line.slice(start, start + maxColWidth));
    }
  }
  return lines;
}

/** Renders a value as the text of a cell. An absent value is empty. */
function toCellText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** Renders one record as the lines of one table row. */
function renderRow(cells: string[][], widths: number[]): string[] {
  const height = Math.max(...cells.map((cell) => cell.length));
  const lines: string[] = [];
  for (let line = 0; line < height; line++) {
    const rendered = cells.map(
      (cell, column) =>
        `${CELL_PADDING}${(cell[line] ?? '').padEnd(widths[column])}${CELL_PADDING}`,
    );
    lines.push(`|${rendered.join('|')}|`);
  }
  return lines;
}

/**
 * Renders rows as a bordered text table.
 *
 * Cells wrap at `maxColWidth` characters, every column is padded to its widest
 * line, and a `+---+` rule is drawn above the header, below the header and
 * below the last row. An empty row list renders the header alone.
 *
 * @param rows The rows to render. A column a row does not have is empty.
 * @param columns The columns to render, in order.
 * @param maxColWidth The greatest number of characters a cell line may hold.
 * @return The rendered table, without a trailing line break.
 */
export function renderGridTable(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
  maxColWidth: number,
): string {
  const headerCells = columns.map((column) => wrapCell(column, maxColWidth));
  const bodyCells = rows.map((row) =>
    columns.map((column) => wrapCell(toCellText(row[column]), maxColWidth)),
  );
  const widths = columns.map((_, column) =>
    Math.max(
      ...[headerCells, ...bodyCells].map((cells) =>
        Math.max(...cells[column].map((line) => line.length)),
      ),
    ),
  );

  const rule = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const lines = [rule, ...renderRow(headerCells, widths), rule];
  for (const cells of bodyCells) {
    lines.push(...renderRow(cells, widths));
  }
  if (bodyCells.length > 0) {
    lines.push(rule);
  }
  return lines.join(LINE_BREAK);
}
