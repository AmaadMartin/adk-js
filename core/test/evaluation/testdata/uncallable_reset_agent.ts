/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '@google/adk';

import {ScriptedLlm} from '../test_helpers.js';

export const agent = {
  rootAgent: new LlmAgent({
    name: 'uncallable_reset_root_agent',
    model: new ScriptedLlm(['unused']),
  }),
  resetData: 'not a function',
};
