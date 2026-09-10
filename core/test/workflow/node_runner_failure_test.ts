/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The runner's own error events and the native-event guard.
 *
 * The error-event cases are ported from `google/adk-python` `main`,
 * `tests/unittests/workflow/test_node_runner_failure.py`; those keep the
 * Python test name verbatim. The guard cases are adk-js's own — adk-python has
 * no equivalent, because its framework overwrites an event's author.
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {
  isNodeErrorEvent,
  NodeErrorEvent,
} from '../../src/workflow/node_error_event.js';
import {createIc} from './test_helpers.js';

interface RunResult {
  events: Event[];
  errorEvents: NodeErrorEvent[];
  ctx?: NodeContext;
  rejection?: unknown;
}

/** Runs `node` as a child, tolerating a rejection so its events stay readable. */
async function runNode(node: BaseNode, input?: unknown): Promise<RunResult> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: createIc(),
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  let rejection: unknown;
  let ctx: NodeContext | undefined;
  const run = root.runNode(node, input, {}).then(
    (result) => {
      ctx = result as NodeContext;
    },
    (err: unknown) => {
      rejection = err;
    },
  );
  const settle = run.then(() => channel.close());
  for await (const event of channel) {
    events.push(event);
  }
  await settle;
  return {events, errorEvents: events.filter(isNodeErrorEvent), ctx, rejection};
}

/** A node that throws `error`, optionally succeeding after `failures` tries. */
class ThrowingNode extends BaseNode {
  private attempts = 0;

  constructor(
    name: string,
    private readonly error: unknown,
    private readonly failures = Number.POSITIVE_INFINITY,
    config: Record<string, unknown> = {},
  ) {
    super({name, ...config});
  }

  protected async *runImpl(): AsyncGenerator<string> {
    this.attempts += 1;
    if (this.attempts <= this.failures) {
      throw this.error;
    }
    yield 'recovered';
  }
}

describe('node_runner — the runner reports its own failures', () => {
  it('test_error_event_emitted_on_failure', async () => {
    const {errorEvents, rejection} = await runNode(
      new ThrowingNode('boom', new Error('it broke')),
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].author).toBe('boom');
    expect(errorEvents[0].errorMessage).toBe('it broke');
    expect(errorEvents[0].attemptCount).toBe(1);
  });

  it('test_error_event_emitted_on_each_retry', async () => {
    // The same error object every attempt, which is what a hoisted error looks
    // like; each attempt still owes the stream an event.
    const shared = new Error('transient');
    const node = new ThrowingNode('flaky', shared, 2, {
      retryConfig: {maxAttempts: 3, initialDelay: 0, jitter: 0},
    });

    const {errorEvents, ctx} = await runNode(node);

    expect(ctx?.output).toBe('recovered');
    expect(errorEvents).toHaveLength(2);
    expect(errorEvents.map((e) => e.attemptCount)).toEqual([1, 2]);
    for (const event of errorEvents) {
      expect(event.errorMessage).toBe('transient');
    }
  });

  it('test_node_runner_prefers_api_status_for_error_code', async () => {
    const apiError = Object.assign(new Error('denied'), {
      status: 'PERMISSION_DENIED',
      code: 403,
    });

    const {errorEvents} = await runNode(new ThrowingNode('api', apiError));

    expect(errorEvents[0].errorCode).toBe('PERMISSION_DENIED');
  });

  it('ignores a numeric status, which is a status code not a status', async () => {
    const httpError = Object.assign(new Error('denied'), {
      status: 403,
      code: 'FORBIDDEN',
    });

    const {errorEvents} = await runNode(new ThrowingNode('http', httpError));

    expect(errorEvents[0].errorCode).toBe('FORBIDDEN');
  });

  it('reports a plain error without a status or code', async () => {
    const {errorEvents} = await runNode(
      new ThrowingNode('plain', new Error('no code')),
    );

    expect(errorEvents[0].errorCode).toBe('UNKNOWN_ERROR');
    expect(errorEvents[0].errorType).toBe('Error');
  });
});

describe('node_runner — only the node\u2019s own events decide route and transfer', () => {
  it('adopts a route from an event the node authored', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<Event> {
        yield createEvent({author: 'mine', route: 'branch_a'});
      }
    }

    const {ctx} = await runNode(new Node({name: 'mine'}));

    expect(ctx?.route).toBe('branch_a');
  });

  it('ignores a route from an event a sub-agent authored', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<Event> {
        yield createEvent({author: 'sub_agent', route: 'branch_a'});
      }
    }

    const {ctx} = await runNode(new Node({name: 'parent'}));

    expect(ctx?.route).toBeUndefined();
  });

  it('adopts transferToAgent from an event the node authored', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<Event> {
        yield createEvent({
          author: 'mine',
          actions: {transferToAgent: 'specialist'},
        });
      }
    }

    const {ctx} = await runNode(new Node({name: 'mine'}));

    expect(ctx?.actions.transferToAgent).toBe('specialist');
  });

  it('ignores transferToAgent from an event a sub-agent authored', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<Event> {
        yield createEvent({
          author: 'sub_agent',
          actions: {transferToAgent: 'specialist'},
        });
      }
    }

    const {ctx} = await runNode(new Node({name: 'parent'}));

    expect(ctx?.actions.transferToAgent).toBeUndefined();
  });

  it('treats an unauthored event as the node\u2019s own', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<Event> {
        yield createEvent({route: 'branch_a'});
      }
    }

    const {ctx} = await runNode(new Node({name: 'anon'}));

    expect(ctx?.route).toBe('branch_a');
  });

  it('sets the output from a messageAsOutput event that carries none', async () => {
    class Node extends BaseNode {
      protected async *runImpl(): AsyncGenerator<Event> {
        yield createEvent({
          content: {role: 'model', parts: [{text: 'the answer'}]},
          nodeInfo: {messageAsOutput: true},
        });
      }
    }

    const {ctx} = await runNode(new Node({name: 'speaker'}));

    expect(ctx?.output).toEqual({role: 'model', parts: [{text: 'the answer'}]});
  });
});
