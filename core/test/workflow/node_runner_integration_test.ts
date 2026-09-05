/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/workflow/test_node_runner_integration.py`, which covers the
 * runner driving a node: the events it enriches and delivers, and the state and
 * artifact deltas it flushes onto them.
 *
 * Test names are kept verbatim so the two suites can be read side by side.
 * Where adk-js deliberately behaves differently the test asserts what adk-js
 * does and says why.
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';
import {createEvent} from '../../src/events/event.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {
  FnNode,
  GenNode,
  runChildNode,
  runFailingChildNode,
} from './test_helpers.js';

function echoNode(name: string): GenNode {
  return new GenNode(name, async function* (_ctx, input) {
    yield input;
  });
}

function interruptEvent(id: string) {
  return createEvent({
    content: {parts: [{functionCall: {name: 'long_tool', args: {}, id}}]},
    longRunningToolIds: [id],
  });
}

describe('node_runner — driving a node', () => {
  it('test_node_output_returned_in_result', async () => {
    const {child} = await runChildNode(echoNode('echo'), {input: 'hello'});

    expect(child.output).toBe('hello');
    expect(child.interruptIds).toEqual([]);
  });

  it('test_no_output_returns_none', async () => {
    const empty = new FnNode('empty', () => undefined);

    const {child} = await runChildNode(empty);

    expect(child.output).toBeUndefined();
    expect(child.interruptIds).toEqual([]);
  });

  it('test_event_author_is_node_name', async () => {
    const {events} = await runChildNode(echoNode('my_node'), {input: 'data'});

    expect(events[0].author).toBe('my_node');
  });

  it('test_event_path_contains_node_name', async () => {
    const {events} = await runChildNode(echoNode('path_test'), {
      input: 'data',
      options: {runId: 'exec-456'},
    });

    // adk-js keeps the run id out of the node path; it is `runId` on the
    // context, and only the dynamic scheduler embeds it in a path.
    expect(events[0].nodeInfo?.path).toBe('path_test');
    expect(events[0].invocationId).toBe('inv-1');
  });

  it('test_interrupt_captured_in_result', async () => {
    const interrupting = new GenNode('interrupt_node', async function* () {
      yield interruptEvent('fc-1');
    });

    const {child} = await runChildNode(interrupting);

    expect(child.interruptIds).toContain('fc-1');
  });

  it('test_node_continues_after_interrupt', async () => {
    const flagFinish = new GenNode('flag_finish', async function* () {
      yield interruptEvent('fc-2');
      yield createEvent({author: 'after_interrupt_1'});
      yield createEvent({author: 'after_interrupt_2'});
    });

    const {child, events} = await runChildNode(flagFinish);

    expect(child.interruptIds).toContain('fc-2');
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it('test_state_mutations_emitted_as_delta', async () => {
    const stateNode = new GenNode('state_node', async function* (ctx) {
      ctx.state.set('key1', 'value1');
      ctx.state.set('key2', 42);
      yield 'done';
    });

    const {events} = await runChildNode(stateNode);

    const deltas = Object.assign(
      {},
      ...events.map((e) => e.actions.stateDelta),
    );
    expect(deltas['key1']).toBe('value1');
    expect(deltas['key2']).toBe(42);
  });

  it('test_artifact_delta_emitted', async () => {
    const artifactNode = new GenNode('artifact_node', async function* (ctx) {
      ctx.actions.artifactDelta['doc.txt'] = 1;
      yield 'saved';
    });

    const {events} = await runChildNode(artifactNode);

    const deltas = Object.assign(
      {},
      ...events.map((e) => e.actions.artifactDelta),
    );
    expect(deltas['doc.txt']).toBe(1);
  });

  it('test_events_enqueued_in_yield_order', async () => {
    const multi = new GenNode('multi', async function* () {
      yield createEvent({author: 'step1'});
      yield createEvent({author: 'step2'});
      yield createEvent({author: 'step3'});
    });

    const {events} = await runChildNode(multi);

    expect(events).toHaveLength(3);
    // Divergence from adk-python, kept deliberately: adk-python overwrites the
    // author with the node's name, adk-js only fills one in when the node left
    // it unset, so a node can speak for a nested agent.
    expect(events.map((e) => e.author)).toEqual(['step1', 'step2', 'step3']);
  });

  it('test_node_exception_propagates', async () => {
    const failing = new FnNode('error_node', () => {
      throw new Error('node failure');
    });

    const {error, events} = await runFailingChildNode(failing);

    // Divergence from adk-python, kept deliberately: adk-python records the
    // failure on the returned context, adk-js rethrows it to the caller.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('node failure');

    const errorEvents = events.filter((e) => e.errorCode !== undefined);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].errorCode).toBe('Error');
    expect(errorEvents[0].errorMessage).toContain('node failure');
  });

  it('test_resume_inputs_available_on_context', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const reader = new GenNode('resume_node', async function* (ctx) {
      captured.push(ctx.resumeInputs);
      yield 'resumed';
    });
    const resume = {'int-1': 'user_response'};

    await runChildNode(reader, {resumeInputs: resume});

    expect(captured[0]).toEqual(resume);
  });

  it('test_node_path_includes_parent', async () => {
    const {events} = await runChildNode(echoNode('child'), {
      input: 'x',
      parentNodePath: 'parent_path',
    });

    // adk-js joins path segments with a dot and leaves the run id out.
    expect(events[0].nodeInfo?.path).toBe('parent_path.child');
  });

  it('test_run_id_generated_when_omitted', async () => {
    const {child} = await runChildNode(echoNode('auto_id'), {input: 'data'});

    expect(child.runId).toBe('auto_id');
  });

  it('test_explicit_run_id_used', async () => {
    const {child} = await runChildNode(echoNode('explicit_id'), {
      input: 'data',
      options: {runId: 'my-exec-id'},
    });

    expect(child.runId).toBe('my-exec-id');
  });

  it('test_route_captured_in_result', async () => {
    const routing = new GenNode('route_node', async function* () {
      yield createEvent({output: 'routed_output', route: 'next'});
    });

    const {child} = await runChildNode(routing);

    expect(child.output).toBe('routed_output');
    expect(child.route).toBe('next');
  });

  it('test_all_events_delivered', async () => {
    const {events} = await runChildNode(echoNode('enqueue_test'), {
      input: 'data',
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('test_node_input_schema_validation', async () => {
    const schema = z.object({name: z.string(), age: z.number()});
    const validating = new GenNode(
      'schema_node',
      async function* (_ctx, input) {
        yield input;
      },
      {inputSchema: schema},
    );

    const {child} = await runChildNode(validating, {
      input: {name: 'Alice', age: 30},
    });
    expect(child.output).toEqual({name: 'Alice', age: 30});

    // Divergence from adk-python, kept deliberately: adk-python records the
    // validation error on the returned context, adk-js rethrows it.
    const {error} = await runFailingChildNode(validating, {
      input: {name: 'Alice'},
    });
    expect(error).toBeInstanceOf(Error);
  });
});

describe('node_runner — delta flushing', () => {
  it('test_state_delta_bundled_with_output_event', async () => {
    const bundled = new GenNode('bundled', async function* (ctx: NodeContext) {
      ctx.state.set('color', 'blue');
      ctx.state.set('count', 7);
      yield 'result';
    });

    const {events} = await runChildNode(bundled);

    expect(events).toHaveLength(1);
    expect(events[0].output).toBe('result');
    expect(events[0].actions.stateDelta['color']).toBe('blue');
    expect(events[0].actions.stateDelta['count']).toBe(7);
  });

  it('test_state_after_last_yield_emitted_separately', async () => {
    const lateState = new GenNode('late_state', async function* (
      ctx: NodeContext,
    ) {
      yield 'early';
      ctx.state.set('late_key', 'late_value');
    });

    const {events} = await runChildNode(lateState);

    expect(events[0].output).toBe('early');
    expect(events[1].actions.stateDelta['late_key']).toBe('late_value');
  });

  it('test_deltas_skip_partial_events', async () => {
    const partialSkip = new GenNode('partial_skip', async function* (
      ctx: NodeContext,
    ) {
      ctx.state.set('before_partial', true);
      yield createEvent({
        content: {parts: [{text: 'streaming...'}]},
        partial: true,
      });
      ctx.state.set('after_partial', true);
      yield 'final';
    });

    const {events} = await runChildNode(partialSkip);

    expect(events[0].partial).toBe(true);
    expect(events[0].actions.stateDelta).toEqual({});
    expect(events[1].output).toBe('final');
    expect(events[1].actions.stateDelta['before_partial']).toBe(true);
    expect(events[1].actions.stateDelta['after_partial']).toBe(true);
  });

  it('test_artifact_and_state_bundled_together', async () => {
    const bothDeltas = new GenNode('both_deltas', async function* (
      ctx: NodeContext,
    ) {
      ctx.state.set('s1', 'v1');
      ctx.actions.artifactDelta['file.txt'] = 1;
      yield 'done';
    });

    const {events} = await runChildNode(bothDeltas);

    expect(events).toHaveLength(1);
    expect(events[0].output).toBe('done');
    expect(events[0].actions.stateDelta['s1']).toBe('v1');
    expect(events[0].actions.artifactDelta['file.txt']).toBe(1);
  });
});
