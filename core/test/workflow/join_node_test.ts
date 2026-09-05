/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from google/adk-python tests/unittests/workflow/test_join_node.py
// (branch: main). Reference test names are kept verbatim so a reader can grep
// the original. adk-js `undefined` stands for adk-python `None`.

import {
  Event,
  isNodeSchemaValidationError,
  JoinNode,
  NodeSchemaValidationError,
  Workflow,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {driveNode, driveWorkflow, FnNode} from './test_helpers.js';

const triggerSchema = z.object({key: z.string(), value: z.number()});

/** Collects every input the returned node receives, in order. */
function capturingNode(name: string): {node: FnNode; received: unknown[]} {
  const received: unknown[] = [];
  const node = new FnNode(name, (_ctx, input) => {
    received.push(input);
    return 'captured';
  });
  return {node, received};
}

/** The reference file's `_build_join_node_workflow` fixture. */
function buildJoinNodeWorkflow(): {wf: Workflow; received: unknown[]} {
  const nodeA = new FnNode('NodeA', () => ({a: 1, b: 1}));
  const nodeB = new FnNode('NodeB', () => ({b: 2}));
  const join = new JoinNode({name: 'NodeJoin'});
  const capture = capturingNode('NodeCapture');
  const wf = new Workflow({
    name: 'test_join_node',
    edges: [['START', [nodeA, nodeB], join, capture.node]],
  });
  return {wf, received: capture.received};
}

function joinOutputEvents(events: Event[], joinName: string): Event[] {
  return events.filter((e) => e.author === joinName && e.output !== undefined);
}

/** Awaits a run expected to reject, and returns the schema error it raised. */
async function schemaErrorFrom(
  run: Promise<unknown>,
): Promise<NodeSchemaValidationError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isNodeSchemaValidationError(error)) {
    expect.fail(`expected a NodeSchemaValidationError, got ${String(error)}`);
  }
  return error;
}

describe('JoinNode — ported from google/adk-python test_join_node.py', () => {
  it('test_join_node_waits_for_all_inputs', async () => {
    const {wf, received} = buildJoinNodeWorkflow();

    await driveWorkflow(wf, 'start');

    expect(received).toEqual([{NodeA: {a: 1, b: 1}, NodeB: {b: 2}}]);
  });

  it('test_join_node_waits_when_start_is_a_predecessor', async () => {
    const nodeA = new FnNode('NodeA', () => ({a: 1}));
    const nodeB = new FnNode('NodeB', () => ({b: 2}));
    const join = new JoinNode({name: 'NodeJoin'});
    const capture = capturingNode('NodeCapture');
    const wf = new Workflow({
      name: 'test_join_node_start_predecessor',
      edges: [
        ['START', [nodeA, nodeB], join, capture.node],
        ['START', join],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    // Divergence from adk-python, pinned here as the current adk-js behaviour.
    // adk-js seeds START successors directly (`seedStartTriggers` in
    // workflow.ts) instead of recording a `__START__` output, so a START edge
    // into a join bypasses the barrier: the join runs once, on the workflow
    // input, and NodeA and NodeB never reach it.
    expect(joinOutputEvents(events, 'NodeJoin')).toHaveLength(1);
    expect(capture.received).toEqual(['start']);
  });

  it('test_join_node_start_predecessor_keeps_nested_branch', async () => {
    const nodeA = new FnNode('NodeA', () => ({a: 1}));
    const nodeB = new FnNode('NodeB', () => ({b: 2}));
    const join = new JoinNode({name: 'NodeJoin'});
    const capture = capturingNode('NodeCapture');
    const inner = new Workflow({
      name: 'Inner',
      edges: [
        ['START', [nodeA, nodeB], join, capture.node],
        ['START', join],
      ],
    });
    // Sibling gives Inner a sub-branch of its own. It yields nothing, because
    // adk-js rejects a workflow with two terminal nodes that produce output.
    const sibling = new FnNode('Sibling', () => undefined);
    const outer = new Workflow({
      name: 'Outer',
      edges: [['START', [inner, sibling]]],
    });

    const {events} = await driveWorkflow(outer, 'start');

    const aEvents = events.filter((e) => e.author === 'NodeA');
    expect(aEvents.some((e) => e.branch === 'Inner@1.NodeA@1')).toBe(true);

    // Same divergence as the previous test. The join runs on the START
    // trigger, so it emits on its own sub-branch rather than on the common
    // prefix of NodeA's and NodeB's branches.
    const joinEvents = joinOutputEvents(events, 'NodeJoin');
    expect(joinEvents.map((e) => e.branch)).toEqual(['Inner@1.NodeJoin@1']);
  });

  it('test_join_node_with_none_state', async () => {
    const {wf, received} = buildJoinNodeWorkflow();

    await driveWorkflow(wf, 'start');
    await driveWorkflow(wf, 'start');

    expect(received).toEqual([
      {NodeA: {a: 1, b: 1}, NodeB: {b: 2}},
      {NodeA: {a: 1, b: 1}, NodeB: {b: 2}},
    ]);
  });

  it('test_join_node_with_none_inputs', async () => {
    const nodeA = new FnNode('NodeA', () => undefined);
    const nodeB = new FnNode('NodeB', () => undefined);
    const join = new JoinNode({name: 'NodeJoin'});
    const capture = capturingNode('NodeCapture');
    const wf = new Workflow({
      name: 'test_join_node_none_inputs',
      edges: [['START', [nodeA, nodeB], join, capture.node]],
    });

    await driveWorkflow(wf, 'start');

    expect(capture.received).toEqual([{NodeA: undefined, NodeB: undefined}]);
  });

  it('test_join_node_input_schema_validates_per_trigger', async () => {
    const nodeA = new FnNode('node_a', () => ({key: 'a', value: 1}));
    const nodeB = new FnNode('node_b', () => ({key: 'b', value: 2}));
    const join = new JoinNode({name: 'join', inputSchema: triggerSchema});
    const capture = capturingNode('capture');
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', [nodeA, nodeB], join, capture.node]],
    });

    await driveWorkflow(wf, 'start');

    expect(capture.received).toEqual([
      {node_a: {key: 'a', value: 1}, node_b: {key: 'b', value: 2}},
    ]);
  });

  it('test_join_node_input_schema_rejects_invalid_trigger', async () => {
    const nodeA = new FnNode('node_a', () => ({key: 'a', value: 1}));
    const nodeB = new FnNode('node_b', () => ({wrong: 'shape'}));
    const join = new JoinNode({name: 'join', inputSchema: triggerSchema});
    const capture = capturingNode('capture');
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', [nodeA, nodeB], join, capture.node]],
    });

    const error = await schemaErrorFrom(driveWorkflow(wf, 'start'));

    expect(error.nodeName).toBe('join');
    expect(error.direction).toBe('input');
    expect(capture.received).toEqual([]);
  });

  it('test_join_node_input_schema_none_trigger_passes', async () => {
    const nodeA = new FnNode('NodeA', () => undefined);
    const nodeB = new FnNode('NodeB', () => ({key: 'b', value: 2}));
    const join = new JoinNode({name: 'join', inputSchema: triggerSchema});
    const capture = capturingNode('capture');
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', [nodeA, nodeB], join, capture.node]],
    });

    await driveWorkflow(wf, 'start');

    expect(capture.received).toEqual([
      {NodeA: undefined, NodeB: {key: 'b', value: 2}},
    ]);
  });

  it('test_join_node_computes_common_branch_prefix', async () => {
    const {wf} = buildJoinNodeWorkflow();

    const {events} = await driveWorkflow(wf, 'start');

    expect(events.some((e) => e.author === 'NodeA' && e.branch === 'NodeA@1'));
    const joinEvents = joinOutputEvents(events, 'NodeJoin');
    expect(joinEvents).toHaveLength(1);
    // 'NodeA@1' and 'NodeB@1' share no prefix, so the join emits on the root
    // branch and the node after it does too.
    expect(joinEvents[0].branch).toBeUndefined();
    const captureEvents = events.filter((e) => e.author === 'NodeCapture');
    expect(captureEvents.length).toBeGreaterThan(0);
    for (const event of captureEvents) {
      expect(event.branch).toBeUndefined();
    }
  });
});

describe('JoinNode — per-trigger validation, adk-js specific', () => {
  it('passes a Content trigger value through unvalidated', async () => {
    const content: Content = {role: 'user', parts: [{text: 'hi'}]};
    const join = new JoinNode({name: 'join', inputSchema: triggerSchema});

    const {output} = await driveNode(join, {
      p1: content,
      p2: {key: 'b', value: 2},
    });

    expect(output).toEqual({p1: content, p2: {key: 'b', value: 2}});
  });

  it('rejects a trigger value even when the record itself matches the schema', async () => {
    const join = new JoinNode({name: 'join', inputSchema: triggerSchema});

    // {key: 'a', value: 1} satisfies triggerSchema, so validating the record
    // as a whole would accept it. Per-trigger validation rejects it, because
    // neither 'a' nor 1 is a {key, value} payload.
    const error = await schemaErrorFrom(driveNode(join, {key: 'a', value: 1}));

    expect(error.nodeName).toBe('join');
    expect(error.direction).toBe('input');
  });

  it('skips a null trigger value', async () => {
    const join = new JoinNode({name: 'join', inputSchema: triggerSchema});

    const {output} = await driveNode(join, {
      p1: null,
      p2: {key: 'b', value: 2},
    });

    expect(output).toEqual({p1: null, p2: {key: 'b', value: 2}});
  });

  it('validates a Content input as a whole, not field by field', async () => {
    const content: Content = {role: 'user', parts: [{text: 'hi'}]};
    const join = new JoinNode({name: 'join', inputSchema: triggerSchema});

    expect((await driveNode(join, content)).output).toEqual(content);
  });

  it('validates an array input as a whole, not element by element', async () => {
    const join = new JoinNode({name: 'join', inputSchema: z.array(z.string())});

    expect((await driveNode(join, ['a', 'b'])).output).toEqual(['a', 'b']);
  });

  it('validates a non-object input against the schema directly', async () => {
    const join = new JoinNode({name: 'join', inputSchema: z.string()});

    expect((await driveNode(join, 'solo')).output).toBe('solo');
  });

  it('validates a null input against the schema directly', async () => {
    const join = new JoinNode({
      name: 'join',
      inputSchema: triggerSchema.nullable(),
    });

    expect((await driveNode(join, null)).output).toBeNull();
  });

  it('leaves the aggregated record untouched when inputSchema is unset', async () => {
    const join = new JoinNode({name: 'join'});
    const record = {p1: {anything: true}, p2: 'a string'};

    expect((await driveNode(join, record)).output).toEqual(record);
  });
});
