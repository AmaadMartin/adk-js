/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {isContent} from '../../workflow/base_node.js';

/**
 * Converts a workflow node's input into the user-role `Content` one ADK turn
 * starts from.
 *
 * Deliberately co-located rather than extracted into `core/src/utils/`. The
 * private `toUserContent` in `workflow/run_llm_agent_as_node.ts` has exactly
 * these semantics, but a shared `content_utils.toUserContent` already exists
 * elsewhere in the project with a different signature and a different answer
 * for an existing `Content`. Reconciling the two is a refactor of its own, and
 * a second file at the shared path would collide with the first.
 *
 * @param input The node input. A `Content` is re-roled to `'user'`, a string
 *     becomes one text part, and anything else is JSON-encoded into one text
 *     part.
 * @returns The user-role content to run the turn from.
 */
export function toNodeInputContent(input: unknown): Content {
  if (isContent(input)) {
    return {...input, role: 'user'};
  }
  if (typeof input === 'string') {
    return {role: 'user', parts: [{text: input}]};
  }
  return {role: 'user', parts: [{text: JSON.stringify(input)}]};
}
