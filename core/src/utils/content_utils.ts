/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * Returns whether a value has the shape of a genai `Content`.
 *
 * `Content` is a structural interface, so there is no constructor to test
 * against. A non-array object carrying either of its two fields is one. A
 * `Part` carries neither, which is what separates the two.
 *
 * @param value The value to test.
 */
export function isContent(value: unknown): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('parts' in value || 'role' in value)
  );
}
