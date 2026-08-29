/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MemoryEntry} from './memory_entry.js';

/**
 * Extracts the text of a memory entry.
 *
 * A part without text (inline data, a function call, a thought) contributes
 * nothing, so it is dropped instead of joined as an empty string. An entry
 * with no text at all therefore yields `''`, which a caller can treat as
 * "nothing to show".
 *
 * @param memory The memory entry to read.
 * @param splitter The separator placed between the text parts.
 */
export function extractText(memory: MemoryEntry, splitter = ' '): string {
  return (memory.content.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => !!text)
    .join(splitter);
}
