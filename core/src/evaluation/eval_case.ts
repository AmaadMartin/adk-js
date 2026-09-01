/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * A single invocation of the agent under test.
 *
 * `adk-python`'s `Invocation` carries more: intermediate data, rubrics, app
 * details and a creation timestamp. Each belongs to a subsystem that is not
 * ported yet, and no metric here reads them.
 */
export interface Invocation {
  /** Unique identifier for the invocation. */
  invocationId?: string;

  /** Content provided by the user in this invocation. */
  userContent: Content;

  /** Final response from the agent. */
  finalResponse?: Content;
}
