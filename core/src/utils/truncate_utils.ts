/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Truncates `text` to at most `limit` characters of original content by
 * dropping the middle, keeping the head and the tail. Returns `text` unchanged
 * when it already fits. The elided region is replaced by a marker naming the
 * number of characters removed, so a reader can tell content is missing.
 *
 * Both ends are preserved because the diagnostically useful part of a large
 * stream is often at its end (a failure summary, the innermost frames of a
 * looping stack trace), which head-only truncation discards.
 *
 * @param text The text to truncate.
 * @param limit Maximum number of original characters to preserve. Negative
 *   values are clamped to zero.
 * @return `text` when it fits, otherwise the head, the marker and the tail.
 */
export function truncateMiddle(text: string, limit: number): string {
  const cap = Math.max(0, limit);
  if (text.length <= cap) {
    return text;
  }
  const headLength = Math.ceil(cap / 2);
  const head = text.slice(0, headLength);
  const tail = text.slice(text.length - (cap - headLength));
  return `${head}\n... [truncated ${text.length - cap} characters] ...\n${tail}`;
}
