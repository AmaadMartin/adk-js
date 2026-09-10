/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for reading genai `Content` and `Part` values.
 */

import {Content} from '@google/genai';

/** Returns whether a value looks like a genai `Content` object. */
export function isContent(value: unknown): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parts' in value &&
    Array.isArray(value.parts)
  );
}
