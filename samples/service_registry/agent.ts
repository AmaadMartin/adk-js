/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {node, Workflow} from '@google/adk';

/**
 * Answers without a model, so the sample runs with no API key. The point of
 * the sample is the session backend beside it, not the agent.
 */
export const rootAgent = new Workflow({
  name: 'service_registry_demo',
  edges: [
    [
      'START',
      node(() => 'The demo session service stored this turn.', {name: 'reply'}),
    ],
  ],
});
