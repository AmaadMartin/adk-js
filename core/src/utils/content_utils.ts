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
 * A `Content` keeps its parts and is re-roled; a string becomes one text part;
 * anything else is serialized to JSON, so a structured value still reaches a
 * model that only reads text.
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
