/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `useAsOutput` delegation contract: a node hands its output to at most one
 * child, and claims the delegate before that child runs. adk-python pins the
 * same rule in `Context._run_node_internal` (`agents/context.py`).
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveWorkflow, FnNode} from './test_helpers.js';

let ic: InvocationContext;
let channel: AsyncQueue<Event>;

beforeEach(() => {
  ic = createIc();
  channel = new AsyncQueue<Event>();
});

function rootCtx(): NodeContext {
  return new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: '1',
  });
}

describe('runNode useAsOutput delegation', () => {
  it('refuses a second delegate from the same node', async () => {
    const first = new FnNode('first', (ctx) => {
      ctx.output = 'one';
    });
    const second = new FnNode('second', (ctx) => {
      ctx.output = 'two';
    });
    const caller = new FnNode('caller', async (ctx) => {
      await ctx.runNode(first, undefined, {useAsOutput: true});
      await ctx.runNode(second, undefined, {useAsOutput: true});
    });

    await expect(rootCtx().runNode(caller)).rejects.toThrow(
      'already has a use_as_output delegate.',
    );
  });

  it('claims the delegate before the child runs, so a failed child still counts', async () => {
    const boom = new FnNode('boom', () => {
      throw new Error('child failed');
    });
    let delegatedAfterFailure: boolean | undefined;
    const caller = new FnNode('caller', async (ctx) => {
      await ctx.runNode(boom, undefined, {useAsOutput: true}).catch(() => {});
      delegatedAfterFailure = ctx.outputDelegated;
    });

    await rootCtx().runNode(caller);

    expect(delegatedAfterFailure).toBe(true);
  });

  it('lets a workflow delegate to each of its nodes in turn', async () => {
    const one = new FunctionNode('one', () => 'one');
    const two = new FunctionNode('two', () => 'two');
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', one],
        [one, two],
      ],
    });

    expect((await driveWorkflow(wf)).output).toBe('two');
  });
});
