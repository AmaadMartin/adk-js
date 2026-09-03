/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * One turn of a conversation, from the user's message to the agent's reply.
 *
 * `adk-python`'s `Invocation` carries more: intermediate data, rubrics and app
 * details. Each belongs to a subsystem that is not ported yet, and no metric
 * here reads them.
 */
export interface Invocation {
  /** Unique identifier for the invocation. Defaults to an empty string. */
  invocationId?: string;

  userContent: Content;

  finalResponse?: Content;

  /**
   * Creation time in seconds since the epoch, for debugging. Defaults to 0.
   */
  creationTimestamp?: number;
}
