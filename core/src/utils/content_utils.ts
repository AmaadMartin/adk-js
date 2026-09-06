/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content} from '@google/genai';

/** Joins the text parts of a content with newlines. */
export function getTextFromContent(content?: Content): string {
  return (content?.parts ?? [])
    .flatMap((part) => (part.text ? [part.text] : []))
    .join('\n');
}
