/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for behaviour the ported set does not reach at unit level. The
 * reference for all of it is `google/adk-python`, branch `main`,
 * `src/google/adk/workflow/_node_runner.py`; adk-python covers the
 * native-author guard only through the full agent stack in
 * `tests/unittests/workflow/test_agent_transfer.py`.
 */

import {describe, expect, it} from 'vitest';
import {createEvent} from '../../src/events/event.js';
import {driveNodeRunner, FnNode, GenNode} from './test_helpers.js';

describe('node runner — only a node’s own event carries its decisions', () => {
  it('takes the route from an event the node authored', async () => {
    const node = new FnNode('router', () =>
      createEvent({author: 'router', route: 'left'}),
    );

    const {child, events} = await driveNodeRunner(node);

    expect(child.route).toBe('left');
    // The event carried the route, so there is no trailing flush for it.
    expect(events).toHaveLength(1);
  });

  it('takes the route from an event that names no author', async () => {
    const node = new FnNode('router', () => createEvent({route: 'left'}));

    const {child} = await driveNodeRunner(node);

    expect(child.route).toBe('left');
  });

  it('ignores the route on an event a nested sub-agent authored', async () => {
    const node = new FnNode('router', () =>
      createEvent({author: 'sub_agent', route: 'left'}),
    );

    const {child, events} = await driveNodeRunner(node);

    expect(child.route).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].route).toBe('left');
  });

  it('takes an agent transfer from an event the node authored', async () => {
    const node = new FnNode('caller', () =>
      createEvent({actions: {transferToAgent: 'helper'}}),
    );

    const {child} = await driveNodeRunner(node);

    expect(child.actions.transferToAgent).toBe('helper');
  });

  it('ignores an agent transfer a nested sub-agent already handled', async () => {
    const node = new FnNode('caller', () =>
      createEvent({author: 'sub_agent', actions: {transferToAgent: 'helper'}}),
    );

    const {child} = await driveNodeRunner(node);

    expect(child.actions.transferToAgent).toBeUndefined();
  });
});

describe('node runner — messageAsOutput promotes the event content', () => {
  it('sets the output from the content when the event carries no output', async () => {
    const node = new FnNode('agent_node', () =>
      createEvent({
        nodeInfo: {messageAsOutput: true},
        content: {role: 'model', parts: [{text: 'hello'}]},
      }),
    );

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toEqual({role: 'model', parts: [{text: 'hello'}]});
    expect(events).toHaveLength(1);
  });

  it('lets the first such event through and suppresses the next', async () => {
    const node = new GenNode('agent_node', async function* () {
      yield createEvent({
        nodeInfo: {messageAsOutput: true},
        output: 'first',
        content: {role: 'model', parts: [{text: 'first'}]},
      });
      yield createEvent({
        nodeInfo: {messageAsOutput: true},
        output: 'second',
        content: {role: 'model', parts: [{text: 'second'}]},
      });
    });

    const {child, events} = await driveNodeRunner(node);

    expect(events).toHaveLength(1);
    expect(events[0].output).toBe('first');
    expect(child.output).toBe('second');
  });
});

describe('node runner — resume state survives a retry', () => {
  it('keeps the prior output and interrupt ids after a failed attempt', async () => {
    let attempts = 0;
    const node = new FnNode(
      'flaky',
      () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error('transient');
        }
        return undefined;
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0}},
    );

    const {child} = await driveNodeRunner(node, {
      priorOutput: 'cached',
      priorInterruptIds: ['fc-old'],
    });

    expect(attempts).toBe(2);
    expect(child.output).toBe('cached');
    expect(child.interruptIds).toEqual(['fc-old']);
  });
});

describe('node runner — per-attempt state is cleared before a retry', () => {
  it('drops the artifact delta a failed attempt left behind', async () => {
    let attempts = 0;
    const node = new FnNode(
      'writer',
      (ctx) => {
        attempts += 1;
        ctx.actions.artifactDelta[`attempt-${attempts}.txt`] = attempts;
        if (attempts < 2) {
          throw new Error('transient');
        }
        return 'ok';
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0}},
    );

    const {events} = await driveNodeRunner(node);

    const merged: Record<string, number> = {};
    for (const event of events) {
      Object.assign(merged, event.actions.artifactDelta);
    }
    expect(merged).toEqual({'attempt-2.txt': 2});
  });
});

describe('node runner — a node that emits its own delta object', () => {
  it('leaves the entries on the event instead of draining them away', async () => {
    // `createEventActions` keeps the delta object it is handed, so a node that
    // passes `ctx.actions.stateDelta` straight through emits the very object
    // the runner drains. Draining it would empty the event it is filling.
    const node = new FnNode('sharer', (ctx) => {
      ctx.state.set('shared', 'value');
      return createEvent({
        output: 'done',
        actions: {stateDelta: ctx.actions.stateDelta},
      });
    });

    const {events} = await driveNodeRunner(node);

    expect(events).toHaveLength(1);
    expect(events[0].actions.stateDelta).toEqual({shared: 'value'});
  });
});

describe('node runner — an output already on the stream is not repeated', () => {
  it('emits one event for a node that returned its output', async () => {
    const node = new FnNode('emitter', () => 'answer');

    const {events} = await driveNodeRunner(node);

    expect(events.filter((e) => e.output !== undefined)).toHaveLength(1);
    expect(events[0].output).toBe('answer');
  });
});
