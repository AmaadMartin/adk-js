/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MAX_OUTPUT_CHARS} from './constants.js';

/** Lowest and highest UTF-16 code units that start a surrogate pair. */
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/**
 * Truncates `text` to `limit` characters and appends a notice naming the
 * original length.
 *
 * The notice is model-facing and is reproduced from adk-python's `truncate` in
 * `src/google/adk/tools/environment/_utils.py`. The reported length counts
 * UTF-16 code units, where Python counts code points, so an astral character
 * contributes 2 here and 1 there.
 *
 * @param text The text to cap.
 * @param limit Maximum number of characters to keep.
 * @return `text` unchanged when it fits, otherwise the capped text plus notice.
 */
export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  // Cutting at a code-unit index can split a surrogate pair and leave a lone
  // high surrogate before the notice, so drop that half of the pair.
  const lastKept = text.charCodeAt(limit - 1);
  const end =
    lastKept >= HIGH_SURROGATE_MIN && lastKept <= HIGH_SURROGATE_MAX
      ? limit - 1
      : limit;
  return `${text.slice(0, end)}\n... (truncated, ${text.length} total chars)`;
}
