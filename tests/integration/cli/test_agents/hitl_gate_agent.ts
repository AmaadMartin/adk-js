/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A workflow that pauses for a human and reports the answer it was given.
 *
 * It runs no model, so `adk run` can be exercised end to end without
 * credentials.
 */

import {node, NodeContext, RequestInput, Workflow} from '@google/adk';

const gate = node(
  (ctx: NodeContext, request: string) => {
    const answer = ctx.resumeInputs['confirm'];
    if (answer === undefined) {
      return new RequestInput({
        interruptId: 'confirm',
        message: `Approve "${request}"?`,
      });
    }
    return `answered:${JSON.stringify(answer)}`;
  },
  {name: 'gate', rerunOnResume: true},
);

export const rootAgent = new Workflow({
  name: 'hitl_gate',
  edges: [['START', gate]],
});
