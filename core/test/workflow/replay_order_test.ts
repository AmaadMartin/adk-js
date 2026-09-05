/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The chronological scan that feeds `ReplaySequenceBarrier`, and the ordering
 * it gives a resumed workflow.
 *
 * The scan ports `google/adk-python`
 * `workflow/utils/_replay_manager.py::_scan_sequence`. The reference has no
 * unit test of its own for it; `tests/unittests/workflow/test_workflow_hitl.py`
 * `test_request_input_resume_after_earlier_invocation_completed` is the
 * regression that motivates scoping the sequence to the run in progress, and
 * the last case here is its adk-js equivalent.
 */

import {describe, expect, it, vi} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {
  eventsForCurrentRun,
  reconstructNodeRuns,
  replaySequence,
} from '../../src/workflow/utils/rehydration_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveWorkflow, FnNode} from './test_helpers.js';

function nodeEvent(path: string, extra: Partial<Event> = {}): Event {
  return createEvent({
    author: path.split('.').pop(),
    invocationId: 'inv-1',
    nodeInfo: {path},
    ...extra,
  });
}

describe('replaySequence', () => {
  it('records the direct children that completed, in order', () => {
    const events = [
      nodeEvent('wf.B', {output: 'b'}),
      nodeEvent('wf.A', {output: 'a'}),
    ];

    expect(replaySequence(events, 'wf')).toEqual(['B', 'A']);
  });

  it('skips a node that produced no terminal event', () => {
    const events = [
      nodeEvent('wf.quiet', {content: {role: 'model', parts: [{text: 'hi'}]}}),
      nodeEvent('wf.A', {output: 'a'}),
    ];

    expect(replaySequence(events, 'wf')).toEqual(['A']);
  });

  it('counts a route and a raised interrupt as completions', () => {
    const events = [
      nodeEvent('wf.router', {route: 'retry'}),
      nodeEvent('wf.gate', {longRunningToolIds: ['i1']}),
    ];

    expect(replaySequence(events, 'wf')).toEqual(['router', 'gate']);
  });

  it('keeps the first position of a node that completed twice', () => {
    const events = [
      nodeEvent('wf.A', {output: 'a1'}),
      nodeEvent('wf.B', {output: 'b'}),
      nodeEvent('wf.A', {output: 'a2'}),
    ];

    // A loop-back node completes again after the nodes it feeds. Keeping the
    // later position would order it behind them, and its first replayed
    // activation would wait for a node that cannot run until it finishes.
    expect(replaySequence(events, 'wf')).toEqual(['A', 'B']);
  });

  it('does not let a workflow echo open another run of the node', () => {
    const events = [
      nodeEvent('wf.A', {output: 'a'}),
      createEvent({
        author: 'wf',
        invocationId: 'inv-1',
        output: 'a',
        nodeInfo: {path: 'wf.A', replayed: true},
      }),
    ];

    expect(reconstructNodeRuns(events, 'wf').get('A')).toHaveLength(1);
  });

  it('ignores events outside this workflow and below its own children', () => {
    const events = [
      nodeEvent('other.A', {output: 'x'}),
      nodeEvent('wf.nested.deep', {output: 'y'}),
      nodeEvent('wf.A', {output: 'a'}),
    ];

    expect(replaySequence(events, 'wf')).toEqual(['A']);
  });

  it('keys by the path leaf when no parent path is given', () => {
    const events = [nodeEvent('wf.A', {output: 'a'})];

    expect(replaySequence(events)).toEqual(['A']);
  });

  it('leaves out a completed earlier run, so its keys cannot block the resume', () => {
    const finished = createEvent({
      author: 'A',
      invocationId: 'inv-0',
      nodeInfo: {path: 'wf.A'},
      output: 'from the finished run',
    });

    const scoped = eventsForCurrentRun(
      [finished, nodeEvent('wf.A', {output: 'a'})],
      'inv-1',
    );

    expect(replaySequence(scoped, 'wf')).toEqual(['A']);
  });
});

describe('Workflow replay ordering', () => {
  /**
   * `A` and `B` run in parallel and both feed `C`. History records `B`
   * finishing first. Scheduling alone would replay `A` first, because the
   * START edges queue it first and both fast-forwards are already resolved, so
   * the order `C` sees is the barrier's doing.
   */
  function graphWithRecordedOrder(seen: string[]) {
    const a = new FnNode('A', () => 'a');
    const b = new FnNode('B', () => 'b');
    const c = new FnNode('C', (_ctx, input) => {
      seen.push(String(input));
      return input;
    });
    return new Workflow({
      name: 'wf',
      edges: [
        ['START', a],
        ['START', b],
        [a, c],
        [b, c],
      ],
    });
  }

  async function runWithHistory(history: Event[], seen: string[]) {
    const ic = createIc();
    ic.session.events.push(...history);
    // The workflow runs under the invocation id createIc fixes, which is the
    // one the seeded history carries.
    return driveWorkflow(graphWithRecordedOrder(seen), 'go', {ic});
  }

  it('replays parallel completions in the order history recorded them', async () => {
    const seen: string[] = [];

    await runWithHistory(
      [nodeEvent('wf.B', {output: 'b'}), nodeEvent('wf.A', {output: 'a'})],
      seen,
    );

    expect(seen).toEqual(['b', 'a']);
  });

  it('replays the mirrored history in the mirrored order', async () => {
    const seen: string[] = [];

    await runWithHistory(
      [nodeEvent('wf.A', {output: 'a'}), nodeEvent('wf.B', {output: 'b'})],
      seen,
    );

    expect(seen).toEqual(['a', 'b']);
  });

  it('runs a fresh workflow in scheduling order, blocking on nothing', async () => {
    const seen: string[] = [];

    await runWithHistory([], seen);

    expect(seen).toEqual(['a', 'b']);
  });
});

/**
 * Collects the events a run streams even when it fails, which `driveWorkflow`
 * cannot: it fails the channel, so the events are lost with the rejection.
 */
async function runCollecting(
  wf: Workflow,
  ic: InvocationContext,
): Promise<{events: Event[]; error: unknown}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  let error: unknown;
  const settle = root.runNode(wf, 'go', {useAsOutput: true}).then(
    () => channel.close(),
    (err) => {
      error = err;
      channel.close();
    },
  );
  for await (const event of channel) {
    events.push(event);
  }
  await settle;
  return {events, error};
}

/** History naming a node the graph no longer has, completing before `A`. */
function divergentHistory(): Event[] {
  return [
    nodeEvent('wf.ghost', {output: 'g'}),
    nodeEvent('wf.A', {output: 'a'}),
  ];
}

describe('Workflow replay divergence', () => {
  it('reports the diverged node as failing, like any other node failure', async () => {
    vi.useFakeTimers();
    try {
      const wf = new Workflow({
        name: 'wf',
        edges: [['START', new FnNode('A', () => 'a')]],
      });
      const ic = createIc();
      ic.session.events.push(...divergentHistory());

      const run = runCollecting(wf, ic);
      await vi.advanceTimersByTimeAsync(15_000);
      const {events, error} = await run;

      expect((error as Error).message).toMatch(/Replay divergence detected/);
      const reported = events.filter((e) => e.errorCode !== undefined);
      expect(reported.map((e) => e.author)).toEqual(['A']);
      expect(reported[0].errorMessage).toMatch(/Replay divergence detected/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a sibling failure at once rather than behind a parked replay', async () => {
    vi.useFakeTimers();
    try {
      const wf = new Workflow({
        name: 'wf',
        edges: [
          ['START', new FnNode('A', () => 'a')],
          [
            'START',
            new FnNode('B', () => {
              throw new Error('B exploded');
            }),
          ],
        ],
      });
      const ic = createIc();
      ic.session.events.push(...divergentHistory());

      // `A` is parked on a key nothing advances. Shutting down has to release
      // it, or `B`'s failure waits out the replay timeout before surfacing.
      const {error} = await runCollecting(wf, ic);

      expect((error as Error).message).toBe('B exploded');
    } finally {
      vi.useRealTimers();
    }
  });
});
