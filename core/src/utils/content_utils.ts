/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, ContentUnion, createUserContent} from '@google/genai';

/** Returns whether a value looks like a genai `Content` object. */
export function isContent(value: unknown): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parts' in value &&
    Array.isArray((value as {parts?: unknown}).parts)
  );
}

/**
 * Converts a value to genai `Content` with the `user` role.
 *
 * A `Content` is returned unchanged, so its identity is preserved. A string, a
 * part, or a list of parts is wrapped. Mirrors `google/adk-python`
 * `_transformers.t_content`.
 */
export function toUserContent(value: ContentUnion): Content {
  return isContent(value) ? value : createUserContent(value);
}
