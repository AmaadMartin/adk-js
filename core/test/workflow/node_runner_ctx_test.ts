/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` `main`,
 * `tests/unittests/workflow/test_node_runner_ctx.py`. Each `it(...)` keeps the
 * Python test name verbatim so a reviewer can grep for it.
 *
 * adk-python tests `is not None`; adk-js treats `undefined` as "no output" and
 * `null` as a legitimate output value, so these assert on `undefined`.
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {createIc} from './test_helpers.js';

/**
 * Runs `node` as a child and returns its events plus its context.
 *
 * `driveNode` is not used: it runs with `useAsOutput: true`, which sets the
 * output-delegation latch that several of these tests are about.
 */
async function runNode(
  node: BaseNode,
  input?: unknown,
): Promise<{events: Event[]; ctx: NodeContext}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: createIc(),
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const run = root.runNode(node, input, {});
  const settle = run.then(
    () => channel.close(),
    (err: unknown) => channel.fail(err),
  );
  for await (const event of channel) {
    events.push(event);
  }
  await settle;
  return {events, ctx: (await run) as NodeContext};
}

describe('node_runner — deferred output and route (ported from adk-python)', () => {
  it('test_ctx_output_set_directly', async () => {
    class Node extends BaseNode {
      // eslint-disable-next-line require-yield -- BaseNode.runImpl must be a generator; this node deliberately yields nothing.
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<never> {
        ctx.output = 'direct';
      }
    }

    const {events, ctx} = await runNode(new Node({name: 'n'}));

    expect(ctx.output).toBe('direct');
    const outputEvents = events.filter((e) => e.output !== undefined);
    expect(outputEvents).toHaveLength(1);
    expect(outputEvents[0].output).toBe('direct');
  });

  it('test_ctx_output_direct_with_state_delta', async () => {
    class Node extends BaseNode {
      // eslint-disable-next-line require-yield -- BaseNode.runImpl must be a generator; this node deliberately yields nothing.
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<never> {
        ctx.state.set('key', 'val');
        ctx.output = 'result';
      }
    }

    const {events, ctx} = await runNode(new Node({name: 'n'}));

    expect(ctx.output).toBe('result');
    const outputEvents = events.filter((e) => e.output !== undefined);
    expect(outputEvents).toHaveLength(1);
    expect(outputEvents[0].actions.stateDelta['key']).toBe('val');
  });

  it('test_deferred_output_emitted_after_intermediate', async () => {
    class Node extends BaseNode {
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<Event> {
        ctx.output = 'deferred';
        yield createEvent({
          content: {role: 'model', parts: [{text: 'working'}]},
        });
      }
    }

    const {events, ctx} = await runNode(new Node({name: 'n'}));

    expect(ctx.output).toBe('deferred');
    expect(events).toHaveLength(2);
    expect(events[0].content?.parts?.[0].text).toBe('working');
    expect(events[1].output).toBe('deferred');
  });

  it('test_ctx_route_set_directly', async () => {
    class Node extends BaseNode {
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<string> {
        ctx.route = 'branch_a';
        yield 'out';
      }
    }

    const {ctx} = await runNode(new Node({name: 'n'}));

    expect(ctx.route).toBe('branch_a');
  });

  it('emits the route on its own event when no event carried it', async () => {
    class Node extends BaseNode {
      // eslint-disable-next-line require-yield -- BaseNode.runImpl must be a generator; this node deliberately yields nothing.
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<never> {
        ctx.route = 'branch_a';
      }
    }

    const {events} = await runNode(new Node({name: 'n'}));

    expect(events).toHaveLength(1);
    expect(events[0].route).toBe('branch_a');
  });

  it('emits nothing when the node leaves no output, route or delta', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<never> {}
    }

    const {events} = await runNode(new Node({name: 'n'}));

    expect(events).toHaveLength(0);
  });

  it('test_event_author_defaults_to_node_name', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<string> {
        yield 'out';
      }
    }

    const {events} = await runNode(new Node({name: 'authored'}));

    expect(events[0].author).toBe('authored');
  });

  // Deliberately NOT named after adk-python's
  // `test_preset_author_overridden_by_framework`, which asserts the opposite:
  // adk-python always stamps the node name, adk-js keeps an author the node
  // set. That divergence is what makes the native-event guard meaningful here,
  // because a sub-agent's author survives to be compared against the node name.
  it('keeps an author the node set on its own event', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<Event> {
        yield createEvent({author: 'preset', content: undefined});
      }
    }

    const {events} = await runNode(new Node({name: 'framework'}));

    expect(events[0].author).toBe('preset');
  });
});
