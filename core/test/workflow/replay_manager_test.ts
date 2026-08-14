/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {
  completionSequence,
  ReplayManager,
  sequenceKey,
} from '../../src/workflow/utils/replay_manager.js';
import {createIc} from './test_helpers.js';

const CURRENT_INVOCATION = 'inv-1';

/** A node event under `path`, carrying whatever `extra` says it produced. */
function nodeEvent(
  path: string,
  extra: Partial<Event> = {},
  invocationId = CURRENT_INVOCATION,
): Event {
  return createEvent({
    author: path.split('.').pop(),
    invocationId,
    nodeInfo: {path},
    ...extra,
  });
}

/** A node event that paused the run for a human, shaped like the engine's own. */
function pauseEvent(path: string, interruptId: string, invocationId: string) {
  return nodeEvent(
    path,
    {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_input',
              id: interruptId,
              args: {},
            },
          },
        ],
      },
      longRunningToolIds: [interruptId],
    },
    invocationId,
  );
}

/** A node context over a session pre-seeded with `events`. */
function contextOver(events: Event[], nodePath = 'wf'): NodeContext {
  const ic = createIc();
  ic.session.events.push(...events);
  return new NodeContext({
    invocationContext: ic,
    channel: new AsyncQueue<Event>(),
    nodePath,
    runId: '1',
  });
}

/** Lets every already-resolved promise settle without advancing the clock. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('sequenceKey', () => {
  it('names the run of a child segment', () => {
    expect(sequenceKey('alpha', 2)).toBe('alpha#2');
  });
});

describe('completionSequence', () => {
  it('lists the direct children that completed, in session order', () => {
    const events = [
      nodeEvent('wf.child1', {output: 'one'}),
      nodeEvent('wf.child2', {output: 'two'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['child1#1', 'child2#1']);
  });

  it('skips a deeper descendant', () => {
    const events = [
      nodeEvent('wf.child', {output: 'one'}),
      nodeEvent('wf.child.grandchild', {output: 'deep'}),
      nodeEvent('other.child', {output: 'elsewhere'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['child#1']);
  });

  it('numbers each run of a node the graph routes back to', () => {
    const events = [
      nodeEvent('wf.alpha', {output: 'a1'}),
      nodeEvent('wf.beta', {output: 'b1'}),
      nodeEvent('wf.alpha', {output: 'a2'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual([
      'alpha#1',
      'beta#1',
      'alpha#2',
    ]);
  });

  it('keeps the run id a dynamic child path carries', () => {
    const events = [
      nodeEvent('wf.child@2', {output: 'two'}),
      nodeEvent('wf.child@1', {output: 'one'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual([
      'child@2#1',
      'child@1#1',
    ]);
  });

  it('counts a route and an interrupt as completions too', () => {
    const events = [
      nodeEvent('wf.router', {route: 'left'}),
      nodeEvent('wf.gate', {longRunningToolIds: ['q']}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['router#1', 'gate#1']);
  });

  it('ignores an event that closes no run', () => {
    const events = [
      nodeEvent('wf.chatty', {content: {role: 'model', parts: [{text: 'hi'}]}}),
      nodeEvent('wf.chatty', {output: 'done'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['chatty#1']);
  });

  it('ignores an event with no node path', () => {
    const events = [
      createEvent({author: 'user', invocationId: CURRENT_INVOCATION}),
      nodeEvent('wf.child', {output: 'one'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['child#1']);
  });
});

describe('ReplayManager', () => {
  it('exposes no barrier before the session is scanned', () => {
    expect(new ReplayManager().sequenceBarrier).toBeUndefined();
  });

  it('builds the static graph barrier from the recorded completions', () => {
    const ctx = contextOver([
      nodeEvent('wf.alpha', {output: 'a'}),
      nodeEvent('wf.beta', {output: 'b'}),
    ]);
    const manager = new ReplayManager();

    const barrier = manager.scanWorkflowEvents(ctx);

    expect(barrier.sequence).toEqual(['alpha#1', 'beta#1']);
    expect(manager.sequenceBarrier).toBe(barrier);
  });

  it('excludes a run that already finished', () => {
    // Invocation `done` ran to completion, so its nodes belong to a finished
    // run and must not gate this one. Invocation `paused` did not.
    const ctx = contextOver([
      createEvent({author: 'user', invocationId: 'done'}),
      nodeEvent('wf.stale', {output: 'old'}, 'done'),
      createEvent({author: 'user', invocationId: 'paused'}),
      nodeEvent('wf.alpha', {output: 'a'}, 'paused'),
      pauseEvent('wf.gate', 'q', 'paused'),
      createEvent({author: 'user', invocationId: CURRENT_INVOCATION}),
    ]);

    const barrier = new ReplayManager().scanWorkflowEvents(ctx);

    expect(barrier.sequence).toEqual(['alpha#1', 'gate#1']);
  });

  it('builds a barrier that never blocks when there is nothing recorded', async () => {
    const ctx = contextOver([]);

    const barrier = new ReplayManager().scanWorkflowEvents(ctx);
    await barrier.wait('anything#1');

    expect(barrier.sequence).toEqual([]);
  });

  it('holds the second key until the first one advances', async () => {
    const ctx = contextOver([
      nodeEvent('wf.alpha', {output: 'a'}),
      nodeEvent('wf.beta', {output: 'b'}),
    ]);
    const manager = new ReplayManager();
    manager.prepareParentSequenceBarrier(ctx, 'wf');

    let released = false;
    const pending = manager.waitSequence('wf', 'beta#1').then(() => {
      released = true;
    });
    await flushMicrotasks();
    expect(released).toBe(false);

    manager.advanceSequence('wf', 'alpha#1');
    await pending;

    expect(released).toBe(true);
  });

  it('keeps the barrier closed when an advance diverges from the recording', () => {
    const ctx = contextOver([
      nodeEvent('wf.alpha', {output: 'a'}),
      nodeEvent('wf.beta', {output: 'b'}),
    ]);
    const manager = new ReplayManager();
    const barrier = manager.prepareParentSequenceBarrier(ctx, 'wf');

    manager.advanceSequence('wf', 'beta#1');

    expect(barrier.currentIndex).toBe(0);
    expect(barrier.isOpen('beta#1')).toBe(false);
  });

  it('never blocks on a parent path with no barrier', async () => {
    const manager = new ReplayManager();

    await manager.waitSequence('never-prepared', 'alpha#1');
  });

  it('does not let an advance on one parent path move another', () => {
    const ctx = contextOver([
      nodeEvent('wf.alpha', {output: 'a'}),
      nodeEvent('wf.beta', {output: 'b'}),
    ]);
    const manager = new ReplayManager();
    const barrier = manager.prepareParentSequenceBarrier(ctx, 'wf');

    manager.advanceSequence('other', 'alpha#1');

    expect(barrier.currentIndex).toBe(0);
  });

  it('memoises a parent barrier instead of rescanning the session', () => {
    const ctx = contextOver([nodeEvent('wf.alpha', {output: 'a'})]);
    const manager = new ReplayManager();

    const first = manager.prepareParentSequenceBarrier(ctx, 'wf');
    ctx.session.events.push(nodeEvent('wf.beta', {output: 'b'}));
    const second = manager.prepareParentSequenceBarrier(ctx, 'wf');

    expect(second).toBe(first);
    expect(second.sequence).toEqual(['alpha#1']);
  });

  it('scopes a dynamic parent barrier to that parent path', () => {
    const ctx = contextOver(
      [
        nodeEvent('wf.alpha.child@1', {output: 'c'}),
        nodeEvent('wf.beta.child@1', {output: 'other'}),
      ],
      'wf',
    );
    const manager = new ReplayManager();

    const barrier = manager.prepareParentSequenceBarrier(ctx, 'wf.alpha');

    expect(barrier.sequence).toEqual(['child@1#1']);
  });
});
