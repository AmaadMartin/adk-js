/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a node context records about its own run: the failure that ended it,
 * where that failure started, and the author its events carry. adk-python keeps
 * the same fields on `Context` (`agents/context.py`: `error`,
 * `error_node_path`, `event_author`).
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
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

describe('NodeContext failure record', () => {
  it('records the failure and the path of the node that raised it', async () => {
    let failing: NodeContext | undefined;
    const boom = new FnNode('boom', (ctx) => {
      failing = ctx;
      throw new Error('kaboom');
    });

    await expect(rootCtx().runNode(boom)).rejects.toThrow('kaboom');

    expect(failing?.error?.message).toBe('kaboom');
    expect(failing?.errorNodePath).toBe('boom');
  });

  it('keeps the original failing path two levels up', async () => {
    const contexts = new Map<string, NodeContext>();
    const inner = new FnNode('inner', (ctx) => {
      contexts.set('inner', ctx);
      throw new Error('inner failed');
    });
    const middle = new FnNode('middle', async (ctx) => {
      contexts.set('middle', ctx);
      await ctx.runNode(inner);
    });
    const outer = new FnNode('outer', async (ctx) => {
      contexts.set('outer', ctx);
      await ctx.runNode(middle);
    });

    await expect(
      driveWorkflow(new Workflow({name: 'wf', edges: [['START', outer]]})),
    ).rejects.toThrow('inner failed');

    const innerPath = contexts.get('inner')!.nodePath;
    expect(contexts.get('inner')!.errorNodePath).toBe(innerPath);
    // The ancestors report where the failure started, not where they are.
    expect(contexts.get('middle')!.errorNodePath).toBe(innerPath);
    expect(contexts.get('outer')!.errorNodePath).toBe(innerPath);
  });

  it('clears the failure record before a retry', async () => {
    let attempts = 0;
    let ctxSeen: NodeContext | undefined;
    const flaky = new FnNode(
      'flaky',
      (ctx) => {
        ctxSeen = ctx;
        attempts += 1;
        if (attempts === 1) {
          throw new Error('first attempt');
        }
        return 'recovered';
      },
      {retryConfig: {maxAttempts: 2}},
    );

    const child = await rootCtx().runNode(flaky);

    expect(child.output).toBe('recovered');
    expect(ctxSeen?.error).toBeUndefined();
    expect(ctxSeen?.errorNodePath).toBe('');
  });
});

describe('NodeContext.eventAuthor', () => {
  it('keeps a nested agent author on an event the agent left unattributed', async () => {
    // An agent run as a node records its own author on the context, so a later
    // event it leaves unattributed is attributed to the agent rather than to
    // the node it was registered under.
    class TwoEventAgent extends BaseAgent {
      protected async *runAsyncImpl(
        ic: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield createEvent({
          author: 'inner_specialist',
          invocationId: ic.invocationId,
          content: {role: 'model', parts: [{text: 'first'}]},
        });
        yield createEvent({
          invocationId: ic.invocationId,
          content: {role: 'model', parts: [{text: 'second'}]},
        });
      }
      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
    }

    const drained: Event[] = [];
    const root = rootCtx();
    const settle = root
      .runNode(new TwoEventAgent({name: 'registered_as'}))
      .then(() => channel.close());
    for await (const event of channel) {
      drained.push(event);
    }
    await settle;

    expect(drained.map((event) => event.author)).toEqual([
      'inner_specialist',
      'inner_specialist',
    ]);
  });

  it('falls back to the node name when nothing set an author', async () => {
    const asker = new FunctionNode(
      'asker',
      () => new RequestInput({interruptId: 'approve-1', message: 'Approve?'}),
    );
    const root = rootCtx();
    const drained: Event[] = [];
    const settle = root.runNode(asker).then(() => channel.close());
    for await (const event of channel) {
      drained.push(event);
    }
    await settle;

    expect(drained.map((event) => event.author)).toEqual(['asker']);
  });

  it('leaves an author the node set for itself alone', async () => {
    const speaker = new FnNode('speaker', (ctx) => {
      ctx.emit(
        createEvent({
          author: 'speaker_itself',
          invocationId: ctx.invocationId,
          content: {role: 'model', parts: [{text: 'hi'}]},
        }),
      );
      return 'done';
    });
    const wf = new Workflow({name: 'billing', edges: [['START', speaker]]});

    const {events} = await driveWorkflow(wf);

    expect(events.map((event) => event.author)).toContain('speaker_itself');
  });

  it('inherits the author from the parent context', () => {
    const parent = rootCtx();
    parent.eventAuthor = 'billing';

    const child = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: 'child',
      runId: '1',
      parentCtx: parent,
    });

    expect(child.eventAuthor).toBe('billing');
    expect(rootCtx().eventAuthor).toBe('');
  });
});
