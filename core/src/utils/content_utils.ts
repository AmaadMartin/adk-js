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
 * Converts a genai `ContentUnion` to `Content` with the `user` role.
 *
 * An already-`Content` value is returned unchanged, so the caller keeps object
 * identity. Anything the SDK cannot turn into parts raises the SDK's own
 * error, mirroring `google/adk-python`'s `_transformers.t_content`.
 */
export function toUserContent(value: ContentUnion): Content {
  return isContent(value) ? value : createUserContent(value);
}
