/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MAX_OUTPUT_CHARS} from './constants.js';

/** First code unit of a UTF-16 surrogate pair. */
const HIGH_SURROGATE_START = 0xd800;

/** Last code unit that can open a UTF-16 surrogate pair. */
const HIGH_SURROGATE_END = 0xdbff;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END;
}

/**
 * Caps `text` at `limit` characters and appends a notice reporting how long it
 * really was.
 *
 * Lengths count UTF-16 code units, so an astral character such as an emoji
 * counts as two. The adk-python reference counts code points, where the same
 * character counts as one, so the reported total can differ between the two
 * SDKs for such text.
 *
 * @param text The text to cap.
 * @param limit Maximum characters to keep. Defaults to {@link MAX_OUTPUT_CHARS}.
 * @returns `text` unchanged when it fits, otherwise the capped text plus the
 *   truncation notice.
 */
export function truncate(
  text: string,
  limit: number = MAX_OUTPUT_CHARS,
): string {
  if (text.length <= limit) {
    return text;
  }
  // Cutting between the halves of a surrogate pair would emit a lone
  // surrogate, so the cut moves back one code unit.
  const end = isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return `${text.slice(0, end)}\n... (truncated, ${text.length} total chars)`;
}
