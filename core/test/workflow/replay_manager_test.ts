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
import {
  createIc,
  flushMicrotasks,
  nodeEvent,
  pauseEvent,
} from './test_helpers.js';

const CURRENT_INVOCATION = 'inv-1';

/** A completed node event in the invocation these tests scan. */
function completed(path: string, extra: Partial<Event>): Event {
  return nodeEvent(CURRENT_INVOCATION, path, extra);
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

describe('sequenceKey', () => {
  it('names the run of a child segment', () => {
    expect(sequenceKey('alpha', 2)).toBe('alpha#2');
  });
});

describe('completionSequence', () => {
  it('lists the direct children that completed, in session order', () => {
    const events = [
      completed('wf.child1', {output: 'one'}),
      completed('wf.child2', {output: 'two'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['child1#1', 'child2#1']);
  });

  it('skips a deeper descendant', () => {
    const events = [
      completed('wf.child', {output: 'one'}),
      completed('wf.child.grandchild', {output: 'deep'}),
      completed('other.child', {output: 'elsewhere'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['child#1']);
  });

  it('numbers each run of a node the graph routes back to', () => {
    const events = [
      completed('wf.alpha', {output: 'a1'}),
      completed('wf.beta', {output: 'b1'}),
      completed('wf.alpha', {output: 'a2'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual([
      'alpha#1',
      'beta#1',
      'alpha#2',
    ]);
  });

  it('keeps the run id a dynamic child path carries', () => {
    const events = [
      completed('wf.child@2', {output: 'two'}),
      completed('wf.child@1', {output: 'one'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual([
      'child@2#1',
      'child@1#1',
    ]);
  });

  it('counts a route and an interrupt as completions too', () => {
    const events = [
      completed('wf.router', {route: 'left'}),
      completed('wf.gate', {longRunningToolIds: ['q']}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['router#1', 'gate#1']);
  });

  it('ignores an event that closes no run', () => {
    const events = [
      completed('wf.chatty', {content: {role: 'model', parts: [{text: 'hi'}]}}),
      completed('wf.chatty', {output: 'done'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['chatty#1']);
  });

  it('ignores an event with no node path', () => {
    const events = [
      createEvent({author: 'user', invocationId: CURRENT_INVOCATION}),
      completed('wf.child', {output: 'one'}),
    ];

    expect(completionSequence(events, 'wf')).toEqual(['child#1']);
  });
});

describe('ReplayManager', () => {
  it('builds a barrier from the recorded completions', () => {
    const ctx = contextOver([
      completed('wf.alpha', {output: 'a'}),
      completed('wf.beta', {output: 'b'}),
    ]);

    const barrier = new ReplayManager().prepareParentSequenceBarrier(ctx, 'wf');

    expect(barrier.sequence).toEqual(['alpha#1', 'beta#1']);
  });

  it('excludes a run that already finished', () => {
    // Invocation `done` ran to completion, so its nodes belong to a finished
    // run and must not gate this one. Invocation `paused` did not.
    const ctx = contextOver([
      createEvent({author: 'user', invocationId: 'done'}),
      nodeEvent('done', 'wf.stale', {output: 'old'}),
      createEvent({author: 'user', invocationId: 'paused'}),
      nodeEvent('paused', 'wf.alpha', {output: 'a'}),
      pauseEvent('paused', 'wf.gate', 'q'),
      createEvent({author: 'user', invocationId: CURRENT_INVOCATION}),
    ]);

    const barrier = new ReplayManager().prepareParentSequenceBarrier(ctx, 'wf');

    expect(barrier.sequence).toEqual(['alpha#1', 'gate#1']);
  });

  it('builds a barrier that never blocks when there is nothing recorded', async () => {
    const ctx = contextOver([]);

    const barrier = new ReplayManager().prepareParentSequenceBarrier(ctx, 'wf');
    await barrier.wait('anything#1');

    expect(barrier.sequence).toEqual([]);
  });

  it('holds the second key until the first one advances', async () => {
    const ctx = contextOver([
      completed('wf.alpha', {output: 'a'}),
      completed('wf.beta', {output: 'b'}),
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
      completed('wf.alpha', {output: 'a'}),
      completed('wf.beta', {output: 'b'}),
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
      completed('wf.alpha', {output: 'a'}),
      completed('wf.beta', {output: 'b'}),
    ]);
    const manager = new ReplayManager();
    const barrier = manager.prepareParentSequenceBarrier(ctx, 'wf');

    manager.advanceSequence('other', 'alpha#1');

    expect(barrier.currentIndex).toBe(0);
  });

  it('memoises a parent barrier instead of rescanning the session', () => {
    const ctx = contextOver([completed('wf.alpha', {output: 'a'})]);
    const manager = new ReplayManager();

    const first = manager.prepareParentSequenceBarrier(ctx, 'wf');
    ctx.session.events.push(completed('wf.beta', {output: 'b'}));
    const second = manager.prepareParentSequenceBarrier(ctx, 'wf');

    expect(second).toBe(first);
    expect(second.sequence).toEqual(['alpha#1']);
  });

  it('scopes a dynamic parent barrier to that parent path', () => {
    const ctx = contextOver(
      [
        completed('wf.alpha.child@1', {output: 'c'}),
        completed('wf.beta.child@1', {output: 'other'}),
      ],
      'wf',
    );
    const manager = new ReplayManager();

    const barrier = manager.prepareParentSequenceBarrier(ctx, 'wf.alpha');

    expect(barrier.sequence).toEqual(['child@1#1']);
  });
});
