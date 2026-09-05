/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` `main`,
 * `tests/unittests/workflow/test_node_runner_integration.py`. Each `it(...)`
 * that has a Python counterpart keeps its name verbatim.
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {createIc} from './test_helpers.js';

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

/** Every state delta across `events`, merged in emission order. */
function mergedStateDelta(events: Event[]): Record<string, unknown> {
  return Object.assign({}, ...events.map((e) => e.actions?.stateDelta ?? {}));
}

describe('node_runner — deltas reach the stream (ported from adk-python)', () => {
  it('test_state_mutations_emitted_as_delta', async () => {
    class Node extends BaseNode {
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<string> {
        ctx.state.set('key1', 'value1');
        ctx.state.set('key2', 42);
        yield 'done';
      }
    }

    const {events} = await runNode(new Node({name: 'state_node'}));

    const deltas = mergedStateDelta(events);
    expect(deltas['key1']).toBe('value1');
    expect(deltas['key2']).toBe(42);
  });

  it('test_artifact_delta_emitted', async () => {
    class Node extends BaseNode {
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<string> {
        ctx.actions.artifactDelta['doc.txt'] = 1;
        yield 'done';
      }
    }

    const {events} = await runNode(new Node({name: 'artifact_node'}));

    const artifacts = Object.assign(
      {},
      ...events.map((e) => e.actions?.artifactDelta ?? {}),
    );
    expect(artifacts['doc.txt']).toBe(1);
  });

  it('test_state_delta_bundled_with_output_event', async () => {
    class Node extends BaseNode {
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<string> {
        ctx.state.set('bundled', 'yes');
        yield 'done';
      }
    }

    const {events} = await runNode(new Node({name: 'bundler'}));

    expect(events).toHaveLength(1);
    expect(events[0].output).toBe('done');
    expect(events[0].actions.stateDelta['bundled']).toBe('yes');
  });

  it('test_state_after_last_yield_emitted_separately', async () => {
    class Node extends BaseNode {
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<string> {
        yield 'early';
        ctx.state.set('late_key', 'late_value');
      }
    }

    const {events} = await runNode(new Node({name: 'late_state'}));

    expect(events).toHaveLength(2);
    expect(events[0].output).toBe('early');
    expect(events[1].actions.stateDelta['late_key']).toBe('late_value');
  });

  it('test_deltas_skip_partial_events', async () => {
    class Node extends BaseNode {
      protected async *runImpl(
        ctx: NodeContext,
      ): AsyncGenerator<Event | string> {
        ctx.state.set('before_partial', true);
        yield createEvent({
          content: {role: 'model', parts: [{text: 'streaming...'}]},
          partial: true,
        });
        ctx.state.set('after_partial', true);
        yield 'final';
      }
    }

    const {events} = await runNode(new Node({name: 'partial_skip'}));

    expect(events[0].partial).toBe(true);
    expect(events[0].actions?.stateDelta ?? {}).toEqual({});
    expect(events[1].output).toBe('final');
    expect(events[1].actions.stateDelta['before_partial']).toBe(true);
    expect(events[1].actions.stateDelta['after_partial']).toBe(true);
  });

  it('test_artifact_and_state_bundled_together', async () => {
    class Node extends BaseNode {
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<string> {
        ctx.state.set('s1', 'v1');
        ctx.actions.artifactDelta['file.txt'] = 1;
        yield 'done';
      }
    }

    const {events} = await runNode(new Node({name: 'both_deltas'}));

    expect(events).toHaveLength(1);
    expect(events[0].output).toBe('done');
    expect(events[0].actions.stateDelta['s1']).toBe('v1');
    expect(events[0].actions.artifactDelta['file.txt']).toBe(1);
  });

  it('keeps the resume checkpoint on an interrupt event that also carries a delta', async () => {
    class Node extends BaseNode {
      protected async *runImpl(ctx: NodeContext): AsyncGenerator<Event> {
        ctx.state.set('pending', 'write');
        yield createEvent({longRunningToolIds: ['ask-1'], content: undefined});
      }
    }

    const {events} = await runNode(new Node({name: 'asker'}), 'the-input');

    const interrupt = events.find((e) => e.longRunningToolIds?.length);
    expect(interrupt).toBeDefined();
    expect(interrupt?.actions.stateDelta['pending']).toBe('write');
    // The delta merge must not drop the input a resumed node re-runs with.
    expect(interrupt?.actions.agentState).toEqual({input: 'the-input'});
  });

  it('test_events_enqueued_in_yield_order', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<string> {
        yield 'one';
        yield 'two';
        yield 'three';
      }
    }

    const {events} = await runNode(new Node({name: 'multi'}));

    expect(events.map((e) => e.output)).toEqual(['one', 'two', 'three']);
    expect(events.every((e) => e.author === 'multi')).toBe(true);
  });

  it('lands a retried FunctionNode write that its shadow map would skip', async () => {
    let attempts = 0;
    const node = new FunctionNode(
      'flaky_writer',
      (ctx: NodeContext) => {
        attempts += 1;
        // The same key and value on every attempt: FunctionNode's own pending
        // map is keyed by context and survives the retry, so it treats the
        // second write as already emitted. The runner's drain still lands it.
        ctx.state.set('written', 'once');
        if (attempts < 2) {
          throw new Error('transient');
        }
        return 'ok';
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0}},
    );

    const {events} = await runNode(node);

    expect(attempts).toBe(2);
    const succeeded = events.filter((e) => e.output === 'ok');
    expect(succeeded).toHaveLength(1);
    expect(mergedStateDelta(succeeded)['written']).toBe('once');
  });
});
