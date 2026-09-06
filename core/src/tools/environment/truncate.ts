/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MAX_OUTPUT_CHARS} from './constants.js';

/**
 * Caps `text` at `limit` characters and appends a notice reporting how long it
 * really was.
 *
 * The notice is model-facing and is reproduced from adk-python's `truncate` in
 * `src/google/adk/tools/environment/_utils.py`. Lengths count code points,
 * matching adk-python, so the cut can never split a surrogate pair.
 *
 * @param text The text to cap.
 * @param limit Maximum characters to keep. Defaults to `MAX_OUTPUT_CHARS`.
 * @returns `text` unchanged when it fits, otherwise the capped text followed by
 *   the truncation notice.
 */
export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  const chars = [...text];
  if (chars.length <= limit) {
    return text;
  }
  return `${chars.slice(0, limit).join('')}\n... (truncated, ${chars.length} total chars)`;
}
