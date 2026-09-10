/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`, branch `main`:
 * `tests/unittests/workflow/test_node_runner_integration.py`, which covers
 * `src/google/adk/workflow/_node_runner.py`.
 *
 * Only the delta-flushing group is ported; the rest of that file is already
 * covered by `node_execution_test.ts`, `branch_path_test.ts` and
 * `isolation_scope_test.ts`. Reference test names are kept verbatim.
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {driveNodeRunner, FnNode, GenNode} from './test_helpers.js';

/** Merges the state delta of every event, the way a session commit would. */
function mergedStateDelta(events: Event[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const event of events) {
    Object.assign(merged, event.actions.stateDelta);
  }
  return merged;
}

/** Merges the artifact delta of every event. */
function mergedArtifactDelta(events: Event[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const event of events) {
    Object.assign(merged, event.actions.artifactDelta);
  }
  return merged;
}

describe('node runner — delta flushing', () => {
  it('test_artifact_delta_emitted', async () => {
    const node = new FnNode('artifact_node', (ctx) => {
      ctx.actions.artifactDelta['doc.txt'] = 1;
      return 'saved';
    });

    const {events} = await driveNodeRunner(node);

    expect(mergedArtifactDelta(events)['doc.txt']).toBe(1);
  });

  it('test_state_delta_bundled_with_output_event', async () => {
    const node = new FnNode('bundled', (ctx) => {
      ctx.state.set('color', 'blue');
      ctx.state.set('count', 7);
      return 'result';
    });

    const {events} = await driveNodeRunner(node);

    expect(events).toHaveLength(1);
    expect(events[0].output).toBe('result');
    expect(events[0].actions.stateDelta['color']).toBe('blue');
    expect(events[0].actions.stateDelta['count']).toBe(7);
  });

  it('test_state_after_last_yield_emitted_separately', async () => {
    const node = new GenNode('late_state', async function* (ctx) {
      yield 'early';
      ctx.state.set('late_key', 'late_value');
    });

    const {events} = await driveNodeRunner(node);

    expect(events).toHaveLength(2);
    expect(events[0].output).toBe('early');
    expect(events[1].actions.stateDelta['late_key']).toBe('late_value');
  });

  it('test_deltas_skip_partial_events', async () => {
    const node = new GenNode('partial_skip', async function* (ctx) {
      ctx.state.set('before_partial', true);
      yield createEvent({
        content: {parts: [{text: 'streaming...'}]},
        partial: true,
      });
      ctx.state.set('after_partial', true);
      yield 'final';
    });

    const {events} = await driveNodeRunner(node);

    expect(events).toHaveLength(2);
    expect(events[0].partial).toBe(true);
    expect(events[0].actions.stateDelta).toEqual({});
    expect(events[1].output).toBe('final');
    expect(events[1].actions.stateDelta).toEqual({
      before_partial: true,
      after_partial: true,
    });
  });

  it('test_artifact_and_state_bundled_together', async () => {
    const node = new FnNode('both_deltas', (ctx) => {
      ctx.state.set('s1', 'v1');
      ctx.actions.artifactDelta['file.txt'] = 1;
      return 'done';
    });

    const {events} = await driveNodeRunner(node);

    expect(events).toHaveLength(1);
    expect(events[0].output).toBe('done');
    expect(events[0].actions.stateDelta['s1']).toBe('v1');
    expect(events[0].actions.artifactDelta['file.txt']).toBe(1);
  });

  it('test_state_mutations_emitted_as_delta', async () => {
    const node = new FnNode('state_node', (ctx) => {
      ctx.state.set('key1', 'value1');
      ctx.state.set('key2', 42);
      return 'done';
    });

    const {events} = await driveNodeRunner(node);

    const deltas = mergedStateDelta(events);
    expect(deltas['key1']).toBe('value1');
    expect(deltas['key2']).toBe(42);
  });
});
