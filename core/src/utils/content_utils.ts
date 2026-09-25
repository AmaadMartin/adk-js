/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, ContentUnion, PartUnion} from '@google/genai';

/**
 * Flattens a `ContentUnion`, such as a system instruction, to its text, for a
 * model API that accepts a plain string. Parts are joined by newlines and
 * non-text parts contribute nothing.
 */
export function contentUnionToText(content: ContentUnion): string {
  const items = Array.isArray(content) ? content : [content];
  return items.map(contentUnionItemText).join('\n');
}

function contentUnionItemText(item: PartUnion | Content): string {
  if (typeof item === 'string') {
    return item;
  }
  if ('parts' in item) {
    return (item.parts ?? []).map((part) => part.text ?? '').join('\n');
  }
  return 'text' in item ? (item.text ?? '') : '';
}
