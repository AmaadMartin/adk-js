/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {isContent} from '../workflow/base_node.js';

/**
 * Converts an arbitrary value into a user-role `Content`.
 *
 * A `Content` keeps its parts and is re-roled to `user`. A string becomes a
 * single text part. Anything else is JSON-encoded into one text part, so a
 * structured payload still reaches a model that only reads text.
 *
 * Mirrors `to_user_content` in google/adk-python `utils/content_utils.py`.
 *
 * @param input The value to convert.
 * @return A `Content` with `role: 'user'`.
 */
export function toUserContent(input: unknown): Content {
  if (isContent(input)) {
    return {...input, role: 'user'};
  }
  if (typeof input === 'string') {
    return {role: 'user', parts: [{text: input}]};
  }
  return {role: 'user', parts: [{text: JSON.stringify(input)}]};
}
