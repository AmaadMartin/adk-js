/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` `tests/unittests/workflow/test_base_node.py`
 * at `main` (`25f5214c`). The `it(...)` names are the Python test names
 * verbatim so the two files can be diffed against each other.
 *
 * Two expectations differ from the reference by design: adk-js joins a node
 * path with `.` rather than `/`, and reports an unreachable target as
 * `undefined` rather than `None`.
 */

import {describe, expect, it} from 'vitest';
import {BaseNode, findStaticNodePath} from '../../src/workflow/base_node.js';
import {FnNode} from './test_helpers.js';

/** The reference's `_Parent`: a node holding children and a back-reference. */
class ParentNode extends FnNode {
  children: BaseNode[];
  parentNode?: BaseNode;

  constructor(name: string, children: BaseNode[] = []) {
    super(name, (_ctx, input) => input);
    this.children = children;
  }
}

/** root -> (team_a -> worker), (team_b -> worker): two nodes named 'worker'. */
function buildTree(): {
  root: ParentNode;
  workerA: ParentNode;
  workerB: ParentNode;
} {
  const workerA = new ParentNode('worker');
  const workerB = new ParentNode('worker');
  const teamA = new ParentNode('team_a', [workerA]);
  const teamB = new ParentNode('team_b', [workerB]);
  workerA.parentNode = teamA;
  workerB.parentNode = teamB;
  const root = new ParentNode('root', [teamA, teamB]);
  teamA.parentNode = root;
  teamB.parentNode = root;
  return {root, workerA, workerB};
}

describe('findStaticNodePath', () => {
  it('test_find_static_node_path_returns_root_path_for_root', () => {
    const {root} = buildTree();
    expect(findStaticNodePath(root, root)).toBe('root');
  });

  it('test_find_static_node_path_disambiguates_same_name_nodes', () => {
    const {root, workerA, workerB} = buildTree();
    expect(findStaticNodePath(root, workerA)).toBe('root.team_a.worker');
    expect(findStaticNodePath(root, workerB)).toBe('root.team_b.worker');
  });

  it('test_find_static_node_path_handles_cycles_and_back_references', () => {
    const {root, workerA, workerB} = buildTree();
    // Introduce an explicit cycle where a leaf node points back to root.
    workerA.children.push(root);

    expect(findStaticNodePath(root, workerA)).toBe('root.team_a.worker');
    expect(findStaticNodePath(root, workerB)).toBe('root.team_b.worker');
    expect(findStaticNodePath(root, new ParentNode('orphan'))).toBeUndefined();
  });

  it('test_find_static_node_path_returns_none_for_unreachable_node', () => {
    const {root} = buildTree();
    expect(findStaticNodePath(root, new ParentNode('orphan'))).toBeUndefined();
  });
});
