/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toErrorMessage} from './error_utils.js';

/** Whether the value is a plain object, i.e. neither null nor an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a JSON object, such as the session state a CLI flag carries.
 *
 * @param value The JSON text to parse.
 * @return The parsed object.
 * @throws SyntaxError when the text is not JSON, Error when it is not an
 *     object.
 */
export function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error(`expected a JSON object, got ${typeof parsed}`);
  }
  return parsed;
}

/**
 * Reads the `--state` option into the state a new session starts from.
 *
 * @param value The option, or undefined when it was not given.
 * @return The parsed state, or undefined when there was none.
 * @throws Error naming the option, for the caller to report.
 */
export function parseStateOption(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return parseJsonObject(value);
  } catch (error: unknown) {
    throw new Error(`Invalid JSON for --state: ${toErrorMessage(error)}`);
  }
}
