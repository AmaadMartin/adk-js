/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {node, Workflow} from '@google/adk';

/** Answers without a model, so the replayed run stays hermetic. */
export const rootAgent = new Workflow({
  name: 'service_registry_demo',
  edges: [['START', node(() => 'done', {name: 'step'})]],
});
