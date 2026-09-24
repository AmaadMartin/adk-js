/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Caps `text` at `limit` characters and appends a notice reporting how long it
 * really was.
 *
 * Lengths count code points, matching adk-python, so the cut can never split a
 * surrogate pair.
 *
 * @param text The text to cap.
 * @param limit Maximum characters to keep.
 * @returns `text` unchanged when it fits, otherwise the capped text followed by
 *   the truncation notice.
 */
export function truncate(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) {
    return text;
  }
  return `${chars.slice(0, limit).join('')}\n... (truncated, ${chars.length} total chars)`;
}
