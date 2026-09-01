/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** An agent module that exports a `rootAgent` and nothing else. */

import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'dice_agent',
  model: 'gemini-2.5-flash',
  subAgents: [new LlmAgent({name: 'roll_agent', model: 'gemini-2.5-flash'})],
});
