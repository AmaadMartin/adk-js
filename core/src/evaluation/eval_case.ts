/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, FunctionCall} from '@google/genai';

/**
 * Intermediate steps an agent produced while it answered one user turn.
 */
export interface IntermediateData {
  /** Tool use trajectory, in chronological order. */
  toolUses: FunctionCall[];
}

/**
 * A single user turn and what the agent did with it.
 */
export interface Invocation {
  /** Content provided by the user in this invocation. */
  userContent: Content;

  /** Intermediate steps generated as part of agent execution. */
  intermediateData?: IntermediateData;
}
