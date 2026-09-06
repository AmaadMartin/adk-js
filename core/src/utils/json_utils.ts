/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from './error_utils.js';

/**
 * Parses JSON, raising a uniform error on malformed input.
 *
 * Wraps `JSON.parse` so callers get one error type and one message shape
 * instead of a bare `SyntaxError` that says nothing about where the text came
 * from.
 *
 * @param text The JSON text to parse.
 * @param context Human-readable label for where `text` came from, for example
 *   `'session state'`. It is included in the error message.
 * @return The parsed value.
 * @throws If `text` is not valid JSON.
 */
export function safeJsonLoads(text: string, context?: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err: unknown) {
    const suffix = context ? ` in ${context}` : '';
    throw new Error(`Invalid JSON${suffix}: ${formatError(err)}`, {cause: err});
  }
}

/** Narrows a decoded JSON value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
