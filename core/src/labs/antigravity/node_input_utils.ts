/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {isContent} from '../../utils/content_utils.js';

/**
 * Converts a workflow node's input into the user-role `Content` one ADK turn
 * starts from.
 *
 * This duplicates the private `toUserContent` in
 * `workflow/run_llm_agent_as_node.ts` rather than extracting it, which needs
 * saying, because the obvious review is "extract it to
 * `core/src/utils/content_utils.ts` and import it from both".
 *
 * That path is already taken on this repository's `parity` branch, by a
 * `toUserContent(value: ContentUnion): Content` that delegates to
 * `createUserContent`. The two disagree: this one forces `role: 'user'` onto a
 * `Content` it is handed, and that one returns it unchanged. Extracting here
 * would put a second, behaviourally different file at the same path, so the
 * merge into `parity` would be an add/add conflict, resolved by whichever
 * definition won — silently changing `run_llm_agent_as_node.ts`.
 *
 * Reconciling the two belongs in its own change, made against `parity` where
 * both are visible. Until then this stays feature-local and touches nothing
 * shared. On `main` alone the extraction looks free, which is exactly the trap.
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
