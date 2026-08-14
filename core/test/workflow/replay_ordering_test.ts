/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resuming a turn that fanned out in parallel.
 *
 * Every fast-forwarded node settles as an already-resolved promise, so without
 * the replay barrier the resumed turn completes them in scheduling order and
 * re-emits the turn in an order the session does not record. These tests pin
 * the recorded order instead, for the static graph and for `ctx.runNode`.
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveWorkflow} from './test_helpers.js';

const CURRENT_INVOCATION = 'inv-1';
const PAUSED_INVOCATION = 'paused';
const INTERRUPT_ID = 'q';

function nodeEvent(path: string, extra: Partial<Event>): Event {
  return createEvent({
    author: path.split('.').pop(),
    invocationId: PAUSED_INVOCATION,
    nodeInfo: {path},
    ...extra,
  });
}

/**
 * A session whose recorded turn completed `paths` in order and then paused on
 * `wf.gate`, with the human's reply already appended.
 */
function seededContext(paths: string[]) {
  const ic = createIc();
  ic.session.events.push(
    createEvent({author: 'user', invocationId: PAUSED_INVOCATION}),
    ...paths.map((path) => nodeEvent(path, {output: path.split('.').pop()})),
    nodeEvent('wf.gate', {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_input',
              id: INTERRUPT_ID,
              args: {},
            },
          },
        ],
      },
      longRunningToolIds: [INTERRUPT_ID],
    }),
    createEvent({
      author: 'user',
      invocationId: CURRENT_INVOCATION,
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: INTERRUPT_ID,
              name: 'adk_request_input',
              response: {result: 'yes'},
            },
          },
        ],
      },
    }),
  );
  return ic;
}

/** The human-input node that paused the recorded turn and now has its answer. */
function gateNode(): FunctionNode {
  return new FunctionNode(
    'gate',
    (ctx: NodeContext) => {
      const reply = ctx.resumeInputs[INTERRUPT_ID];
      return reply === undefined
        ? new RequestInput({interruptId: INTERRUPT_ID, message: 'q?'})
        : `got:${reply}`;
    },
    {rerunOnResume: true},
  );
}

describe('replaying a resumed turn in its recorded order', () => {
  it('completes static graph nodes in the order the session records', async () => {
    // The recording completed `beta` first. Scheduling order is alpha, beta.
    const arrivals: string[] = [];
    const alpha = new FunctionNode('alpha', () => 'alpha');
    const beta = new FunctionNode('beta', () => 'beta');
    const observer = new FunctionNode(
      'observer',
      (_ctx: NodeContext, input: unknown) => {
        arrivals.push(String(input));
        // Produces no output, so it has no recorded run to fast-forward and
        // re-runs on this turn — which is what makes it an observer.
        return undefined;
      },
    );

    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', alpha, observer],
        ['START', beta, observer],
        ['START', gateNode()],
      ],
    });

    const {output} = await driveWorkflow(wf, 'go', {
      ic: seededContext(['wf.beta', 'wf.alpha']),
    });

    expect(arrivals).toEqual(['beta', 'alpha']);
    expect(output).toBe('got:yes');
  });

  it('completes ctx.runNode children in the order the session records', async () => {
    // The recording completed `childB@1` first; the entry starts `childA` first.
    const settled: string[] = [];
    const childA = new FunctionNode('childA', () => 'childA');
    const childB = new FunctionNode('childB', () => 'childB');
    const gate = gateNode();

    const wf = new Workflow({
      name: 'wf',
      dynamicEntry: async (ctx: NodeContext) => {
        await Promise.all([
          ctx.runNode(childA).then(() => settled.push('childA')),
          ctx.runNode(childB).then(() => settled.push('childB')),
        ]);
        const answered = await ctx.runNode(gate);
        return answered.output;
      },
    });

    const {output} = await driveWorkflow(wf, 'go', {
      ic: seededContext(['wf.childB@1', 'wf.childA@1']),
    });

    expect(settled).toEqual(['childB', 'childA']);
    expect(output).toBe('got:yes');
  });
});
