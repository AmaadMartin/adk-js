/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Allow-list validation for the Spanner SQL fragments a model can influence.
 *
 * `similarity_search` builds its query by concatenating table, column and
 * filter text that arrives as tool arguments, so each fragment is checked
 * against a grammar before it reaches the query. These are the checks
 * adk-python's `search_tool.py` applies, with the same grammar and the same
 * messages.
 */

/**
 * One part of an identifier: a bare name, or a name quoted with backticks or
 * double quotes. A quoted name may not contain its own quote or a backslash.
 */
const IDENTIFIER_PART = '(?:[A-Za-z_][A-Za-z0-9_]*|`[^`\\\\]+`|"[^"\\\\]+")';

/** A possibly schema-qualified identifier, for example `my_schema.my_table`. */
const IDENTIFIER = `${IDENTIFIER_PART}(?:\\.${IDENTIFIER_PART})*`;

const SAFE_IDENTIFIER_RE = new RegExp(`^${IDENTIFIER}$`);

const COMPARISON_OPERATOR =
  '(?:=|!=|<=|>=|<|>|\\bLIKE\\b|\\bIS\\s+NOT\\b|\\bIS\\b)';

/** Numbers, single-quoted strings without backslashes, booleans and NULL. */
const VALUE =
  "(?:[+-]?\\d+(?:\\.\\d+)?|'[^'\\\\]*'|\\bTRUE\\b|\\bFALSE\\b|\\bNULL\\b)";

const IN_OPERATOR = '(?:\\bNOT\\s+IN\\b|\\bIN\\b)';
const IN_VALUES = `\\(\\s*${VALUE}(?:\\s*,\\s*${VALUE})*\\s*\\)`;
const BETWEEN_VALUES = `${VALUE}\\s+\\bAND\\b\\s+${VALUE}`;

/** A single condition, without parentheses. */
const CONDITION = [
  `${IDENTIFIER}\\s*${COMPARISON_OPERATOR}\\s*${VALUE}`,
  `${IDENTIFIER}\\s*${IN_OPERATOR}\\s*${IN_VALUES}`,
  `${IDENTIFIER}\\s*\\bBETWEEN\\b\\s*${BETWEEN_VALUES}`,
  IDENTIFIER,
  '1\\s*=\\s*1',
]
  .map((alternative) => `(?:${alternative})`)
  .join('|');

const JOINER = '\\s+(?:\\bAND\\b|\\bOR\\b)\\s+';

/** Joins conditions of the given kind with `AND` and `OR`. */
function joined(condition: string): string {
  return `(?:${condition})(?:${JOINER}(?:${condition}))*`;
}

/** Wraps a block of conditions in one more level of parentheses. */
function parenthesized(block: string): string {
  return `(?:(?:${CONDITION})|\\(\\s*(?:${block})\\s*\\))`;
}

const LEVEL_1 = parenthesized(joined(CONDITION));
const LEVEL_2 = parenthesized(joined(LEVEL_1));

const SAFE_FILTER_RE = new RegExp(`^\\s*${joined(LEVEL_2)}\\s*$`, 'i');

/** The Vertex AI model endpoint format Spanner's PostgreSQL dialect expects. */
const VERTEX_AI_ENDPOINT_RE =
  /^projects\/[\w-]+\/locations\/[\w-]+\/publishers\/[\w-]+\/models\/[\w.-]+$/;

/**
 * Checks that a value is an identifier that is safe to concatenate into SQL.
 *
 * @param value The identifier to check.
 * @param paramName The tool parameter it came from, named in the error.
 * @throws If the value is empty or is not a plain or quoted identifier.
 */
export function validateIdentifier(value: string, paramName: string): void {
  if (!value || !SAFE_IDENTIFIER_RE.test(value.trim())) {
    throw new Error(
      `Invalid SQL identifier for ${paramName}: '${value}'. ` +
        'Identifiers must contain only alphanumeric characters, underscores, ' +
        'and dots, or be quoted with backticks or double quotes.',
    );
  }
}

/**
 * Checks every name in a column list.
 *
 * @param columns The column names to check.
 * @param paramName The tool parameter they came from, named in the error.
 * @throws If any name is not a safe identifier.
 */
export function validateColumnList(columns: string[], paramName: string): void {
  for (const column of columns) {
    validateIdentifier(column, paramName);
  }
}

/**
 * Checks that a filter matches the supported grammar: comparisons, `LIKE`,
 * `IS`, `IN`, `BETWEEN` and bare boolean columns, joined by `AND` or `OR`,
 * with up to two levels of parentheses.
 *
 * @param filter The filter expression to check.
 * @throws If the filter does not match the grammar.
 */
export function validateAdditionalFilter(filter: string): void {
  if (!SAFE_FILTER_RE.test(filter)) {
    throw new Error(
      `additional_filter contains unsafe or unsupported patterns: '${filter}'. ` +
        'Only simple filters using =, !=, <=, >=, <, >, LIKE, IS, IS NOT, IN, ' +
        'BETWEEN joined by AND or OR (with up to 2 levels of nested ' +
        'parentheses) are allowed.',
    );
  }
}

/**
 * Checks that a Vertex AI model endpoint is fully qualified.
 *
 * @param endpoint The endpoint to check.
 * @throws If the endpoint is not of the form
 *   `projects/$project/locations/$location/publishers/$publisher/models/$model`.
 */
export function validateVertexAiEndpoint(endpoint: string): void {
  if (!VERTEX_AI_ENDPOINT_RE.test(endpoint)) {
    throw new Error(
      `Invalid Vertex AI endpoint format: '${endpoint}'. Expected format: ` +
        'projects/$project/locations/$location/publishers/google/models/$model',
    );
  }
}
