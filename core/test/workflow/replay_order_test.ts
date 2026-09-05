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

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {
  eventsForCurrentRun,
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

    expect(replaySequence(events, 'wf')).toEqual(['B@1', 'A@1']);
  });

  it('skips a node that produced no terminal event', () => {
    const events = [
      nodeEvent('wf.quiet', {content: {role: 'model', parts: [{text: 'hi'}]}}),
      nodeEvent('wf.A', {output: 'a'}),
    ];

    expect(replaySequence(events, 'wf')).toEqual(['A@1']);
  });

  it('counts a route and a raised interrupt as completions', () => {
    const events = [
      nodeEvent('wf.router', {route: 'retry'}),
      nodeEvent('wf.gate', {longRunningToolIds: ['i1']}),
    ];

    expect(replaySequence(events, 'wf')).toEqual(['router@1', 'gate@1']);
  });

  it('numbers a repeated node by its run', () => {
    const events = [
      nodeEvent('wf.A', {output: 'a1'}),
      nodeEvent('wf.B', {output: 'b'}),
      nodeEvent('wf.A', {output: 'a2'}),
    ];

    expect(replaySequence(events, 'wf')).toEqual(['A@1', 'B@1', 'A@2']);
  });

  it('ignores events outside this workflow and below its own children', () => {
    const events = [
      nodeEvent('other.A', {output: 'x'}),
      nodeEvent('wf.nested.deep', {output: 'y'}),
      nodeEvent('wf.A', {output: 'a'}),
    ];

    expect(replaySequence(events, 'wf')).toEqual(['A@1']);
  });

  it('keys by the path leaf when no parent path is given', () => {
    const events = [nodeEvent('wf.A', {output: 'a'})];

    expect(replaySequence(events)).toEqual(['A@1']);
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

    expect(replaySequence(scoped, 'wf')).toEqual(['A@1']);
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

describe('Workflow run ids', () => {
  it('gives a replayed activation its own run number', async () => {
    const scopes: Array<string | undefined> = [];
    const worker = new FnNode(
      'worker',
      (ctx) => {
        scopes.push(ctx.isolationScope);
        return 'done';
      },
      {isolationScope: true},
    );
    const router = new FnNode('router', () =>
      createEvent({route: scopes.length === 0 ? 'again' : 'out'}),
    );
    const sink = new FnNode('sink', (_ctx, input) => input);
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', worker, router],
        [router, {again: worker, out: sink}],
      ],
    });

    const ic = createIc();
    ic.session.events.push(nodeEvent('wf.worker', {output: 'replayed'}));
    await driveWorkflow(wf, 'go', {ic});

    // The first activation replayed, so it consumed run 1 without running.
    // The real second activation is therefore run 2, and its isolation scope
    // says so.
    expect(scopes).toEqual(['wf.worker@2']);
  });
});
