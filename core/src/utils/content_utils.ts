/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for reading a genai `Content` as plain text, and for telling whether
 * reading it that way loses anything.
 */

import {Content} from '@google/genai';

/**
 * Joins the text of every text part, with no separator.
 *
 * A part carrying anything else contributes nothing. Ask
 * {@link contentHasNonTextParts} whether that happened.
 */
export function contentToText(content: Content): string {
  let text = '';
  for (const part of content.parts ?? []) {
    if (part.text !== undefined && part.text !== null) {
      text += part.text;
    }
  }
  return text;
}

/**
 * Whether any part carries data that {@link contentToText} drops: inline data,
 * file data or executable code.
 *
 * A part carrying none of those three is not counted, so a thought part or an
 * empty part does not make a `Content` lossy to read as text.
 */
export function contentHasNonTextParts(content: Content): boolean {
  return (content.parts ?? []).some(
    (part) =>
      part.inlineData !== undefined ||
      part.fileData !== undefined ||
      part.executableCode !== undefined,
  );
}
