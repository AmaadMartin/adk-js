/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Allowlists for the parts of a Spanner search that reach generated SQL.
 *
 * The model populates the table name, the column names and the additional
 * filter of `spanner_similarity_search`, and those values are interpolated
 * into the statement rather than bound as parameters. The grammars below are
 * therefore a security control: anything outside them is refused before a
 * statement is built. They are ported from adk-python's `search_tool.py`.
 */

/** One part of an identifier: bare, backtick-quoted or double-quoted. */
const IDENTIFIER_PART = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|\`[^\`\\]+\`|"[^"\\]+")`;

/** A possibly schema-qualified identifier, quoted per part. */
const IDENTIFIER = `${IDENTIFIER_PART}(?:\\.${IDENTIFIER_PART})*`;

const SAFE_IDENTIFIER_RE = new RegExp(`^${IDENTIFIER}$`);

/** Comparison operators a filter may use. */
const OPERATORS = String.raw`(?:=|!=|<=|>=|<|>|\bLIKE\b|\bIS\s+NOT\b|\bIS\b)`;

/** Literals a filter may compare against. */
const VALUES = String.raw`(?:[+-]?\d+(?:\.\d+)?|'[^'\\]*'|\bTRUE\b|\bFALSE\b|\bNULL\b)`;

const IN_OPERATOR = String.raw`(?:\bNOT\s+IN\b|\bIN\b)`;
const IN_VALUES = String.raw`\(\s*${VALUES}(?:\s*,\s*${VALUES})*\s*\)`;
const BETWEEN_VALUE = String.raw`${VALUES}\s+\bAND\b\s+${VALUES}`;

/** One condition, without parentheses. */
const BASE_CONDITION =
  `(?:${IDENTIFIER}\\s*${OPERATORS}\\s*${VALUES}` +
  `|${IDENTIFIER}\\s*${IN_OPERATOR}\\s*${IN_VALUES}` +
  `|${IDENTIFIER}\\s*\\bBETWEEN\\b\\s*${BETWEEN_VALUE}` +
  `|${IDENTIFIER}` +
  `|1\\s*=\\s*1)`;

/** Joins conditions into a block, then wraps a block in one more paren level. */
function joined(condition: string): string {
  return `${condition}(?:\\s+(?:\\bAND\\b|\\bOR\\b)\\s+${condition})*`;
}
function parenthesized(block: string): string {
  return `(?:${BASE_CONDITION}|\\(\\s*${block}\\s*\\))`;
}

const NESTED_CONDITION = parenthesized(
  joined(parenthesized(joined(BASE_CONDITION))),
);

/** Conditions joined by AND/OR, with up to two levels of nested parentheses. */
const SAFE_FILTER_RE = new RegExp(`^\\s*${joined(NESTED_CONDITION)}\\s*$`, 'i');

/**
 * Rejects a value that is not a safe SQL identifier.
 *
 * @param value The identifier, which may be schema-qualified.
 * @param paramName The parameter the value came from, named in the error.
 * @throws Error if the value is empty or contains anything outside the
 *   identifier grammar.
 */
export function validateIdentifier(value: string, paramName: string): void {
  if (!value || !SAFE_IDENTIFIER_RE.test(value.trim())) {
    throw new Error(
      `Invalid SQL identifier for ${paramName}: ${JSON.stringify(value)}. ` +
        'Identifiers must contain only alphanumeric characters, underscores, ' +
        'and dots, or be quoted with backticks or double quotes.',
    );
  }
}

/**
 * Rejects a column list holding anything that is not a safe SQL identifier.
 *
 * @param columns The column names.
 * @param paramName The parameter the list came from, named in the error.
 * @throws Error if any entry fails {@link validateIdentifier}.
 */
export function validateColumnList(
  columns: readonly string[],
  paramName: string,
): void {
  for (const column of columns) {
    validateIdentifier(column, paramName);
  }
}

/** The only shape a Vertex AI model endpoint may take. */
const VERTEX_AI_ENDPOINT_RE =
  /^projects\/[\w-]+\/locations\/[\w-]+\/publishers\/[\w-]+\/models\/[\w.-]+$/;

/**
 * Rejects a Vertex AI model endpoint that is not a well-formed resource name.
 *
 * The endpoint is quoted into the `spanner.ML_PREDICT_ROW` call, so it is
 * checked for the same reason the identifiers above are.
 *
 * @param endpoint The fully qualified model endpoint.
 * @throws Error if the endpoint does not name a publisher model.
 */
export function validateVertexAiEndpoint(endpoint: string): void {
  if (!VERTEX_AI_ENDPOINT_RE.test(endpoint)) {
    throw new Error(
      `Invalid Vertex AI endpoint format: ${JSON.stringify(endpoint)}. ` +
        'Expected format: ' +
        'projects/$project/locations/$location/publishers/google/models/$model',
    );
  }
}

/**
 * Rejects an additional filter outside the allowed grammar.
 *
 * The filter is documented as developer-supplied, but a model can populate it
 * through a tool call, so it is checked rather than trusted.
 *
 * @param filter The filter expression.
 * @throws Error if the filter uses anything outside the comparison, `IN`,
 *   `BETWEEN` and `AND`/`OR` grammar.
 */
export function validateAdditionalFilter(filter: string): void {
  if (!SAFE_FILTER_RE.test(filter)) {
    throw new Error(
      `additional_filter contains unsafe or unsupported patterns: ` +
        `${JSON.stringify(filter)}. Only simple filters using =, !=, <=, >=, ` +
        '<, >, LIKE, IS, IS NOT, IN, BETWEEN joined by AND or OR (with up to ' +
        '2 levels of nested parentheses) are allowed.',
    );
  }
}
