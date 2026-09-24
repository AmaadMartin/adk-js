/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Matches the opening fence of a Markdown code block, with its language tag. */
const OPENING_CODE_FENCE = /^```[a-zA-Z]*\n/;

/** Matches the closing fence of a Markdown code block. */
const CLOSING_CODE_FENCE = /\n```$/;

/**
 * Reports whether `value` is a JSON object rather than an array or a scalar.
 *
 * @param value The value to test.
 * @returns True when `value` can be read as a keyed JSON object.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses JSON a model produced, tolerating a Markdown code fence around it.
 *
 * A model asked for raw JSON often answers with the document wrapped in
 * ```` ```json ```` … ```` ``` ````. The fence is formatting, not data, so it is
 * removed before parsing.
 *
 * @param text The raw text the model produced.
 * @returns The parsed value, or `undefined` when `text` is not valid JSON.
 *     `undefined` is unambiguous here, because JSON cannot encode it.
 */
export function parseFencedJson(text: string): unknown {
  const withoutFence = text
    .trim()
    .replace(OPENING_CODE_FENCE, '')
    .replace(CLOSING_CODE_FENCE, '')
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    return undefined;
  }
}
