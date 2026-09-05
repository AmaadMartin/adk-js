/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`, branch `main`:
 * `tests/unittests/workflow/test_node_runner_ctx.py`, which covers
 * `src/google/adk/workflow/_node_runner.py`.
 *
 * Reference test names are kept verbatim so a reviewer can grep for the
 * original. Where adk-js and adk-python deliberately disagree, the test asserts
 * the TARGET's behaviour and a comment names the divergence.
 */

import {describe, expect, it} from 'vitest';
import {createEvent} from '../../src/events/event.js';
import {driveNodeRunner, FnNode, GenNode} from './test_helpers.js';

describe('node runner — ctx.output set directly', () => {
  it('test_ctx_output_set_directly', async () => {
    const node = new FnNode('n', (ctx) => {
      ctx.output = 'direct';
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toBe('direct');
    const outputEvents = events.filter((e) => e.output !== undefined);
    expect(outputEvents).toHaveLength(1);
    expect(outputEvents[0].output).toBe('direct');
  });

  it('test_ctx_output_direct_with_state_delta', async () => {
    const node = new FnNode('n', (ctx) => {
      ctx.state.set('key', 'val');
      ctx.output = 'result';
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toBe('result');
    const outputEvents = events.filter((e) => e.output !== undefined);
    expect(outputEvents).toHaveLength(1);
    expect(outputEvents[0].actions.stateDelta['key']).toBe('val');
  });

  it('test_deferred_output_emitted_after_intermediate', async () => {
    const node = new GenNode('n', async function* (ctx) {
      ctx.output = 'deferred';
      yield createEvent({content: {role: 'model', parts: [{text: 'working'}]}});
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toBe('deferred');
    expect(events).toHaveLength(2);
    expect(events[0].content?.parts?.[0].text).toBe('working');
    expect(events[1].output).toBe('deferred');
  });
});

describe('node runner — ctx.output written twice', () => {
  /**
   * Divergence from adk-python: its `Context.output` setter raises
   * `ValueError('...already set...')` on a second assignment
   * (`agents/context.py`). adk-js lets the last write win and relies on it —
   * `resetState` assigns `undefined` between retries, and the plugin
   * after-node hook assigns a replacement. The reference tests
   * `test_double_output_raises` and `test_yield_then_ctx_output_raises` are
   * therefore ported asserting the target's behaviour: no error event.
   */
  it('test_double_output_raises', async () => {
    const node = new FnNode('n', (ctx) => {
      ctx.output = 'first';
      ctx.output = 'second';
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toBe('second');
    expect(events.filter((e) => e.errorCode !== undefined)).toHaveLength(0);
  });

  it('test_yield_then_ctx_output_raises', async () => {
    const node = new GenNode('n', async function* (ctx) {
      yield 'first';
      ctx.output = 'second';
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toBe('second');
    expect(events.filter((e) => e.errorCode !== undefined)).toHaveLength(0);
    // The first value already went out on its own event, so the end-of-node
    // flush does not emit the second one.
    expect(events.filter((e) => e.output !== undefined)).toHaveLength(1);
    expect(events[0].output).toBe('first');
  });
});

describe('node runner — ctx.route', () => {
  it('test_ctx_route_set_directly', async () => {
    const node = new FnNode('n', (ctx) => {
      ctx.route = 'branch_a';
      return 'out';
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.route).toBe('branch_a');
    const routeEvents = events.filter((e) => e.route !== undefined);
    expect(routeEvents).toHaveLength(1);
    expect(routeEvents[0].route).toBe('branch_a');
  });
});

describe('node runner — output delegation', () => {
  it('test_delegated_output_not_enqueued', async () => {
    const node = new FnNode('n', (ctx) => {
      ctx.outputDelegated = true;
      return 'delegated_value';
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toBe('delegated_value');
    expect(events.filter((e) => e.output !== undefined)).toHaveLength(0);
  });

  it('test_delegated_ctx_output_not_emitted', async () => {
    const node = new FnNode('n', (ctx) => {
      ctx.outputDelegated = true;
      ctx.output = 'delegated_direct';
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toBe('delegated_direct');
    expect(events.filter((e) => e.output !== undefined)).toHaveLength(0);
  });

  it('test_delegated_output_preserves_event_details', async () => {
    const node = new FnNode('n', (ctx) => {
      ctx.outputDelegated = true;
      return createEvent({
        output: 'delegated_value',
        actions: {stateDelta: {foo: 'bar'}},
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
    });

    const {child, events} = await driveNodeRunner(node);

    expect(child.output).toBe('delegated_value');
    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].actions.stateDelta).toEqual({foo: 'bar'});
    // Divergence from adk-python, which clears only `output` and keeps
    // `content`. adk-js clears the content too: the delegate already emitted
    // that text, so keeping it puts the same text in the stream twice.
    expect(events[0].content).toBeUndefined();
  });

  it('test_delegated_output_with_artifact_delta_is_enqueued', async () => {
    // The reference covers only a state delta here. adk-python's
    // `_has_non_output_content` also accepts an artifact delta, so this pins
    // the other half of that condition.
    const node = new FnNode('n', (ctx) => {
      ctx.outputDelegated = true;
      return createEvent({
        output: 'delegated_value',
        actions: {artifactDelta: {'doc.txt': 3}},
      });
    });

    const {events} = await driveNodeRunner(node);

    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].actions.artifactDelta).toEqual({'doc.txt': 3});
  });
});

describe('node runner — resume state carried forward', () => {
  it('test_prior_output_carried_forward', async () => {
    const node = new FnNode('n', () => undefined);

    const {child, events} = await driveNodeRunner(node, {
      priorOutput: 'cached_result',
    });

    expect(child.output).toBe('cached_result');
    // A carried-forward output was already emitted last turn, so it must not
    // be emitted again.
    expect(events.filter((e) => e.output !== undefined)).toHaveLength(0);
  });

  it('test_prior_interrupt_ids_carried_forward', async () => {
    const node = new FnNode('n', () => undefined);

    const {child} = await driveNodeRunner(node, {
      priorInterruptIds: ['fc-old'],
    });

    expect(child.interruptIds).toContain('fc-old');
  });

  it('test_prior_and_new_interrupt_ids_merged', async () => {
    const node = new FnNode('n', () =>
      createEvent({
        content: {
          parts: [{functionCall: {name: 'tool', args: {}, id: 'fc-new'}}],
        },
        longRunningToolIds: ['fc-new'],
      }),
    );

    const {child} = await driveNodeRunner(node, {
      priorInterruptIds: ['fc-old'],
    });

    expect([...child.interruptIds].sort()).toEqual(['fc-new', 'fc-old']);
  });
});
