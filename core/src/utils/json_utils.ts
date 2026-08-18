/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The markdown code fence delimiter, opening and closing. */
const FENCE = '```';

/**
 * Matches the opening fence and its optional language tag. The tag cannot
 * contain a backtick, so this never runs past the opener, and its single
 * quantifier is anchored, so matching is linear in the tag length.
 */
const FENCE_OPENER = /^```\w*/;

/**
 * Removes a markdown code fence wrapping the entire JSON payload, if present.
 *
 * A model asked for structured output occasionally wraps it in a fenced code
 * block, most often when tools are configured alongside an output schema and
 * the schema constraint becomes best-effort. Well-formed JSON never starts
 * with a fence, so this is a no-op on valid input.
 *
 * Model text is attacker-influenced, so the payload is located by string
 * search rather than by one regex spanning it. A single pattern of the form
 * `fence, tag, lazy body, fence` backtracks catastrophically on a fence that
 * is never closed.
 *
 * @param text Model-produced text that is about to be parsed as JSON.
 * @return The fence-free payload, or `text` unchanged when it is not a whole
 *     fenced block.
 */
export function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const opener = FENCE_OPENER.exec(trimmed);
  if (
    !opener ||
    !trimmed.endsWith(FENCE) ||
    trimmed.length < opener[0].length + FENCE.length
  ) {
    return text;
  }
  return trimmed.slice(opener[0].length, -FENCE.length).trim();
}
