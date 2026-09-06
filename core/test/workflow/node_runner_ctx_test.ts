/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/workflow/test_node_runner_ctx.py`, which covers the node
 * context as the result channel of a node run: the output, route and interrupt
 * ids the runner writes onto it, and the resume state it carries forward.
 *
 * Test names are kept verbatim so the two suites can be read side by side.
 * Where adk-js deliberately behaves differently the test asserts what adk-js
 * does and says why.
 *
 * adk-python tests `is not None`; adk-js treats `undefined` as "no output" and
 * `null` as a legitimate output value, so these assert on `undefined`.
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {createIc, FnNode, GenNode, runChildNode} from './test_helpers.js';

/** The events that carry an output, which is what most assertions read. */
function outputEvents(events: Event[]): Event[] {
  return events.filter((e) => e.output !== undefined);
}

describe('node_runner — ctx.output from yielded events', () => {
  it('test_yield_value_sets_ctx_output', async () => {
    const n = new GenNode('n', async function* () {
      yield 'hello';
    });

    const {child} = await runChildNode(n);

    expect(child.output).toBe('hello');
  });

  it('test_yield_event_output_sets_ctx_output', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({output: 'from_event'});
    });

    const {child} = await runChildNode(n);

    expect(child.output).toBe('from_event');
  });

  it('test_no_yield_leaves_ctx_output_none', async () => {
    const n = new FnNode('n', () => undefined);

    const {child, events} = await runChildNode(n);

    expect(child.output).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});

describe('node_runner — ctx.output set directly', () => {
  it('test_ctx_output_set_directly', async () => {
    const n = new FnNode('n', (ctx) => {
      ctx.output = 'direct';
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('direct');
    expect(outputEvents(events)).toHaveLength(1);
    expect(outputEvents(events)[0].output).toBe('direct');
  });

  it('test_ctx_output_direct_with_state_delta', async () => {
    const n = new FnNode('n', (ctx) => {
      ctx.state.set('key', 'val');
      ctx.output = 'result';
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('result');
    const withOutput = outputEvents(events);
    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].actions.stateDelta['key']).toBe('val');
  });

  it('test_deferred_output_emitted_after_intermediate', async () => {
    const n = new GenNode('n', async function* (ctx: NodeContext) {
      ctx.output = 'deferred';
      yield createEvent({content: {parts: [{text: 'working'}]}});
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('deferred');
    expect(events).toHaveLength(2);
    expect(events[0].content?.parts?.[0].text).toBe('working');
    expect(events[1].output).toBe('deferred');
  });
});

describe('node_runner — ctx.output written twice', () => {
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
    const n = new FnNode('n', (ctx) => {
      ctx.output = 'first';
      ctx.output = 'second';
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('second');
    expect(events.filter((e) => e.errorCode !== undefined)).toHaveLength(0);
  });

  it('test_yield_then_ctx_output_raises', async () => {
    const n = new GenNode('n', async function* (ctx: NodeContext) {
      yield 'first';
      ctx.output = 'second';
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('second');
    expect(events.filter((e) => e.errorCode !== undefined)).toHaveLength(0);
    // The first value already went out on its own event, so the end-of-node
    // flush does not emit the second one.
    expect(outputEvents(events)).toHaveLength(1);
    expect(events[0].output).toBe('first');
  });
});

describe('node_runner — ctx.route', () => {
  it('test_yield_route_sets_ctx_route', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({output: 'out', route: 'next'});
    });

    const {child} = await runChildNode(n);

    expect(child.output).toBe('out');
    expect(child.route).toBe('next');
  });

  it('test_ctx_route_set_directly', async () => {
    const n = new GenNode('n', async function* (ctx: NodeContext) {
      ctx.route = 'branch_a';
      yield 'out';
    });

    const {child, events} = await runChildNode(n);

    expect(child.route).toBe('branch_a');
    // A route the node assigned rather than emitted still reaches the session:
    // the run ends with an event carrying it.
    expect(events.map((e) => e.route)).toEqual([undefined, 'branch_a']);
  });

  it('emits the route on its own event when no event carried it', async () => {
    // eslint-disable-next-line require-yield -- a GenNode body is a generator; this one deliberately yields nothing.
    const n = new GenNode('n', async function* (ctx: NodeContext) {
      ctx.route = 'branch_a';
    });

    const {events} = await runChildNode(n);

    expect(events).toHaveLength(1);
    expect(events[0].route).toBe('branch_a');
  });

  it('emits nothing when the node leaves no output, route or delta', async () => {
    const n = new GenNode('n', async function* () {});

    const {events} = await runChildNode(n);

    expect(events).toHaveLength(0);
  });
});

describe('node_runner — ctx.interruptIds', () => {
  it('test_interrupt_sets_ctx_interrupt_ids', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({
        content: {
          parts: [{functionCall: {name: 'tool', args: {}, id: 'fc-1'}}],
        },
        longRunningToolIds: ['fc-1'],
      });
    });

    const {child} = await runChildNode(n);

    expect(child.interruptIds).toEqual(['fc-1']);
    expect(child.output).toBeUndefined();
  });

  it('test_output_and_interrupt_coexist', async () => {
    const n = new GenNode('n', async function* () {
      yield 'result';
      yield createEvent({
        content: {
          parts: [{functionCall: {name: 'tool', args: {}, id: 'fc-1'}}],
        },
        longRunningToolIds: ['fc-1'],
      });
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('result');
    expect(child.interruptIds).toEqual(['fc-1']);
    // A node that stopped to ask the user gets no end-of-node flush, so the
    // output it already emitted is not repeated.
    expect(outputEvents(events)).toHaveLength(1);
  });

  it('test_duplicate_interrupt_ids_deduplicated', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({longRunningToolIds: ['fc-1', 'fc-2']});
      yield createEvent({longRunningToolIds: ['fc-2', 'fc-3']});
    });

    const {child} = await runChildNode(n);

    expect([...child.interruptIds].sort()).toEqual(['fc-1', 'fc-2', 'fc-3']);
  });
});

describe('node_runner — output delegation', () => {
  it('test_delegated_output_not_enqueued', async () => {
    const n = new GenNode('n', async function* (ctx: NodeContext) {
      ctx.outputDelegated = true;
      yield 'delegated_value';
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('delegated_value');
    expect(outputEvents(events)).toHaveLength(0);
  });

  it('test_delegated_ctx_output_not_emitted', async () => {
    const n = new FnNode('n', (ctx) => {
      ctx.outputDelegated = true;
      ctx.output = 'delegated_direct';
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('delegated_direct');
    expect(outputEvents(events)).toHaveLength(0);
  });

  it('test_delegated_output_preserves_event_details', async () => {
    const n = new GenNode('n', async function* (ctx: NodeContext) {
      ctx.outputDelegated = true;
      yield createEvent({
        output: 'delegated_value',
        actions: {stateDelta: {foo: 'bar'}},
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
    });

    const {child, events} = await runChildNode(n);

    expect(child.output).toBe('delegated_value');
    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].actions.stateDelta).toEqual({foo: 'bar'});
    // Divergence from adk-python, kept deliberately: adk-python preserves the
    // content of a delegated event, adk-js clears it because the delegate
    // emits the same text and it appeared twice in the stream.
    expect(events[0].content).toBeUndefined();
  });

  it('test_delegated_output_with_artifact_delta_is_enqueued', async () => {
    // The reference covers only a state delta here. adk-python's
    // `_has_non_output_content` also accepts an artifact delta, so this pins
    // the other half of that condition.
    const n = new FnNode('n', (ctx) => {
      ctx.outputDelegated = true;
      return createEvent({
        output: 'delegated_value',
        actions: {artifactDelta: {'doc.txt': 3}},
      });
    });

    const {events} = await runChildNode(n);

    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].actions.artifactDelta).toEqual({'doc.txt': 3});
  });
});

describe('node_runner — resume state carried forward', () => {
  it('test_prior_output_carried_forward', async () => {
    const n = new FnNode('n', () => undefined);

    const {child, events} = await runChildNode(n, {
      priorOutput: 'cached_result',
    });

    expect(child.output).toBe('cached_result');
    // A carried-forward output was already emitted last turn, so it must not
    // be emitted again.
    expect(outputEvents(events)).toHaveLength(0);
  });

  it('test_prior_interrupt_ids_carried_forward', async () => {
    const n = new FnNode('n', () => undefined);

    const {child} = await runChildNode(n, {priorInterruptIds: ['fc-old']});

    expect(child.interruptIds).toContain('fc-old');
  });

  it('test_prior_and_new_interrupt_ids_merged', async () => {
    const n = new FnNode('n', () =>
      createEvent({
        content: {
          parts: [{functionCall: {name: 'tool', args: {}, id: 'fc-new'}}],
        },
        longRunningToolIds: ['fc-new'],
      }),
    );

    const {child} = await runChildNode(n, {priorInterruptIds: ['fc-old']});

    expect([...child.interruptIds].sort()).toEqual(['fc-new', 'fc-old']);
  });

  it('keeps the prior output and interrupt ids after a failed attempt', async () => {
    let attempts = 0;
    const flaky = new FnNode(
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

    const {child} = await runChildNode(flaky, {
      priorOutput: 'cached',
      priorInterruptIds: ['fc-old'],
    });

    expect(attempts).toBe(2);
    expect(child.output).toBe('cached');
    expect(child.interruptIds).toEqual(['fc-old']);
  });
});

describe('node_runner — event enrichment', () => {
  it('test_event_author_defaults_to_node_name', async () => {
    const n = new GenNode('my_node', async function* () {
      yield 'result';
    });

    const {events} = await runChildNode(n);

    expect(events[0].author).toBe('my_node');
  });

  // Deliberately NOT named after adk-python's
  // `test_preset_author_overridden_by_framework`, which asserts the opposite:
  // adk-python always stamps the node name, adk-js keeps an author the node
  // set. That divergence is what makes the native-event guard meaningful here,
  // because a sub-agent's author survives to be compared against the node name.
  it('keeps an author the node set on its own event', async () => {
    const n = new GenNode('framework', async function* () {
      yield createEvent({author: 'preset', content: undefined});
    });

    const {events} = await runChildNode(n);

    expect(events[0].author).toBe('preset');
  });

  it('test_override_branch_used_in_node_runner', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({output: 'result'});
    });

    const {events} = await runChildNode(n, {
      options: {overrideBranch: 'custom_branch'},
    });

    expect(events[0].branch).toBe('custom_branch');
  });

  it('test_use_sub_branch_appends_segment_to_branch', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({output: 'result'});
    });

    const {events} = await runChildNode(n, {
      ic: createIc(),
      options: {useSubBranch: true, runId: '1'},
    });

    expect(events[0].branch).toBe('n@1');
  });

  it('test_sequential_branch_propagation', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({output: 'result'});
    });

    const {events} = await runChildNode(n, {
      options: {overrideBranch: 'parent_branch'},
    });

    expect(events[0].branch).toBe('parent_branch');
  });

  it('test_child_event_branch_does_not_mutate_parent_ic', async () => {
    const ic = createIc();
    const n = new GenNode('n', async function* () {
      yield createEvent({output: 'result', branch: 'new_child_branch'});
    });

    const {events} = await runChildNode(n, {ic});

    expect(events[0].branch).toBe('new_child_branch');
    expect(ic.branch).toBeUndefined();
  });

  it('test_override_isolation_scope_used_in_node_runner', async () => {
    const seen: Array<string | undefined> = [];
    const n = new GenNode('n', async function* (ctx: NodeContext) {
      seen.push(ctx.isolationScope);
      yield createEvent({output: 'result'});
    });

    const {events} = await runChildNode(n, {
      options: {overrideIsolationScope: 'task:fc-999'},
    });

    expect(seen).toEqual(['task:fc-999']);
    expect(events[0].isolationScope).toBe('task:fc-999');
  });
});
