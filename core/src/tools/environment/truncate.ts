/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MAX_OUTPUT_CHARS} from './constants.js';

/** Highest and lowest UTF-16 code unit of a leading surrogate. */
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

/**
 * Caps `text` at `limit` characters and appends a notice when it cuts.
 *
 * The limit counts UTF-16 code units, so a character outside the Basic
 * Multilingual Plane costs two. A cut that would land between the two halves
 * of a surrogate pair drops the leading half rather than emitting it alone.
 *
 * @param text The text to cap.
 * @param limit Maximum characters to keep.
 * @return `text` unchanged when it fits, otherwise the kept prefix followed by
 *   a notice giving the original length.
 */
export function truncate(
  text: string,
  limit: number = MAX_OUTPUT_CHARS,
): string {
  if (text.length <= limit) {
    return text;
  }
  const lastKept = text.charCodeAt(limit - 1);
  const cut =
    lastKept >= HIGH_SURROGATE_START && lastKept <= HIGH_SURROGATE_END
      ? limit - 1
      : limit;
  return `${text.slice(0, cut)}\n... (truncated, ${text.length} total chars)`;
}
