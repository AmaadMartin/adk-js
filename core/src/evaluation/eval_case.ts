/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * One turn of a conversation, from the user's message to the agent's reply.
 *
 * `adk-python`'s `Invocation` carries more: an id, a creation timestamp,
 * intermediate data, rubrics and app details. Each belongs to a subsystem
 * that is not ported yet, and no metric here reads them.
 */
export interface Invocation {
  userContent: Content;

  finalResponse?: Content;
}
