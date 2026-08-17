/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Matches a markdown code fence wrapping an entire payload, capturing its
 * contents. Anchored at both ends so a payload that merely contains backticks
 * is left alone.
 */
const CODE_FENCE_PATTERN = /^```\w*\s*([\s\S]*?)\s*```$/;

/**
 * Removes a markdown code fence wrapping the entire JSON payload, if present.
 *
 * A model asked for structured output occasionally wraps it in a fenced code
 * block, most often when tools are configured alongside an output schema and
 * the schema constraint becomes best-effort. Well-formed JSON never starts
 * with a fence, so this is a no-op on valid input.
 *
 * @param text Model-produced text that is about to be parsed as JSON.
 * @return The fence-free payload, or `text` unchanged when it is not a whole
 *     fenced block.
 */
export function stripJsonCodeFence(text: string): string {
  const match = CODE_FENCE_PATTERN.exec(text.trim());
  return match ? match[1].trim() : text;
}
