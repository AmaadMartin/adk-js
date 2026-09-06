/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Writes rows of data as comma-separated values.
 *
 * Fields are escaped per RFC 4180: a field that holds a comma, a double quote
 * or a line break is wrapped in double quotes, and each double quote inside it
 * is doubled. Records end with a line feed rather than the CRLF the RFC
 * prefers, so that the files match what other ADK tooling writes.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Characters that force a field to be quoted. */
const MUST_QUOTE = /[",\r\n]/;

/** Escapes one field. */
function toField(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return MUST_QUOTE.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Renders rows as CSV text.
 *
 * @param rows The rows to render. A column a row does not have is empty.
 * @param columns The columns to render, in order.
 * @param includeHeader Whether to start with a row of column names.
 * @return The CSV text, ending with a line feed when it is not empty.
 */
export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
  includeHeader: boolean,
): string {
  const lines: string[] = [];
  if (includeHeader) {
    lines.push(columns.map(toField).join(','));
  }
  for (const row of rows) {
    lines.push(columns.map((column) => toField(row[column])).join(','));
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Appends rows to a CSV file, creating it and its parent directories when
 * they do not exist. The header row is written only for a new or empty file,
 * so repeated calls produce one table rather than several.
 */
export async function appendCsv(
  filePath: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  const handle = await fs.open(filePath, 'a');
  try {
    const {size} = await handle.stat();
    await handle.appendFile(toCsv(rows, columns, size === 0), 'utf-8');
  } finally {
    await handle.close();
  }
}
