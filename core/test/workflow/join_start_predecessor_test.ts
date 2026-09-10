/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A wait-for-all node wired straight off START still waits for its other
 * predecessors. START never executes, so it is satisfied as soon as the
 * workflow begins and contributes the workflow input under its own name.
 *
 * Ported from `google/adk-python` `tests/unittests/workflow/test_join_node.py`
 * at `25f5214c`.
 */

import {describe, expect, it} from 'vitest';
import {Event} from '../../src/events/event.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow} from './test_helpers.js';

describe('a JoinNode fed directly by START', () => {
  it('test_join_node_waits_when_start_is_a_predecessor', async () => {
    const received: unknown[] = [];
    const nodeA = new FunctionNode('NodeA', () => ({a: 1}));
    const nodeB = new FunctionNode('NodeB', () => ({b: 2}));
    const nodeJoin = new JoinNode({name: 'NodeJoin'});
    const nodeCapture = new FunctionNode('NodeCapture', (_c, input) => {
      received.push(input);
      return 'captured';
    });
    const wf = new Workflow({
      name: 'test_join_node_start_predecessor',
      edges: [
        ['START', nodeA],
        ['START', nodeB],
        ['START', nodeJoin],
        [nodeA, nodeJoin],
        [nodeB, nodeJoin],
        [nodeJoin, nodeCapture],
      ],
    });

    await driveWorkflow(wf, 'start');

    expect(received).toEqual([
      {__START__: 'start', NodeA: {a: 1}, NodeB: {b: 2}},
    ]);
  });

  it('test_join_node_start_predecessor_keeps_nested_branch', async () => {
    const nodeA = new FunctionNode('NodeA', () => ({a: 1}));
    const nodeB = new FunctionNode('NodeB', () => ({b: 2}));
    const nodeJoin = new JoinNode({name: 'NodeJoin'});
    const nodeCapture = new FunctionNode('NodeCapture', () => 'captured');
    const inner = new Workflow({
      name: 'Inner',
      edges: [
        ['START', nodeA],
        ['START', nodeB],
        ['START', nodeJoin],
        [nodeA, nodeJoin],
        [nodeB, nodeJoin],
        [nodeJoin, nodeCapture],
      ],
    });
    // A second START edge in the outer workflow gives Inner a sub-branch of
    // its own, so the join's predecessors run under `Inner@1.<node>@1`.
    const sibling = new FunctionNode('Sibling', () => undefined);
    const outer = new Workflow({
      name: 'Outer',
      edges: [
        ['START', inner],
        ['START', sibling],
      ],
    });

    const {events} = await driveWorkflow(outer, 'start');

    const branchesOf = (name: string) =>
      events
        .filter((e: Event) => e.nodeInfo?.path?.includes(name))
        .map((e) => e.branch);
    expect(branchesOf('NodeA')).toContain('Inner@1.NodeA@1');

    // START contributes Inner's own branch, so the common prefix of
    // ['Inner@1', 'Inner@1.NodeA@1', 'Inner@1.NodeB@1'] is still 'Inner@1'.
    // Recording an empty branch for START would collapse it to the root.
    const joinOutputs = events.filter(
      (e: Event) =>
        e.nodeInfo?.path?.includes('NodeJoin') && e.output !== undefined,
    );
    expect(joinOutputs).toHaveLength(1);
    expect(joinOutputs[0].branch).toBe('Inner@1');
  });
});
