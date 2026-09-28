/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, Workflow} from '@google/adk';

import {ScriptedLlm} from '../test_helpers.js';

const agentNode = new LlmAgent({
  name: 'workflow_agent',
  model: new ScriptedLlm(['from the workflow']),
});

export const agent = {
  rootAgent: new Workflow({
    name: 'fixture_workflow',
    edges: [['START', agentNode]],
  }),
};
