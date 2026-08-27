/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MemoryEntry} from './memory_entry.js';

/**
 * Extracts the text of a memory entry by joining its text parts.
 *
 * Parts that carry no text, such as function calls and inline data, are
 * dropped instead of joined as empty strings. They therefore contribute no
 * separator, and an entry that holds no text at all returns an empty string.
 *
 * @param memory The memory entry to read.
 * @param splitter Separator placed between text parts. Defaults to a space.
 * @return The joined text, or an empty string if the entry has no text.
 */
export function extractText(memory: MemoryEntry, splitter = ' '): string {
  const parts = memory.content.parts;
  if (!parts) {
    return '';
  }
  return parts
    .map((part) => part.text)
    .filter((text): text is string => !!text)
    .join(splitter);
}
