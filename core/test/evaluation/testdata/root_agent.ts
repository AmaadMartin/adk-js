/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '@google/adk';

import {ScriptedLlm} from '../test_helpers.js';

/** Counts how many times the eval system reset this module. */
export const resetCalls: string[] = [];

const subAgent = new LlmAgent({
  name: 'fixture_sub_agent',
  model: new ScriptedLlm(['from the sub agent']),
});

export const agent = {
  rootAgent: new LlmAgent({
    name: 'fixture_root_agent',
    model: new ScriptedLlm(['from the root agent']),
    subAgents: [subAgent],
  }),
  resetData: () => resetCalls.push('reset'),
};
