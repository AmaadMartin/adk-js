/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` `tests/unittests/workflow/test_base_node.py`
 * @ `main`. All four reference tests are here, under their original names.
 *
 * Two adaptations, and no others:
 *  - adk-js's `BaseNode` is abstract, so the fixture uses a concrete subclass
 *    carrying `children` and `parentNode` where Python instantiates `BaseNode`
 *    with extra Pydantic fields.
 *  - a path segment is joined with `.`, not `/` (see `findStaticNodePath`).
 */

import {BaseNode, findStaticNodePath} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** The reference's `_Parent`: a node holding children and a back-reference. */
class ParentNode extends BaseNode {
  children: BaseNode[] = [];
  parentNode?: BaseNode;

  protected runImpl(): AsyncGenerator<never, void, void> {
    throw new Error('not executed');
  }
}

/** root -> (team_a -> worker), (team_b -> worker): two nodes named 'worker'. */
function buildTree(): {
  root: ParentNode;
  workerA: ParentNode;
  workerB: ParentNode;
} {
  const workerA = new ParentNode({name: 'worker'});
  const workerB = new ParentNode({name: 'worker'});
  const teamA = new ParentNode({name: 'team_a'});
  const teamB = new ParentNode({name: 'team_b'});
  teamA.children = [workerA];
  teamB.children = [workerB];
  workerA.parentNode = teamA;
  workerB.parentNode = teamB;
  const root = new ParentNode({name: 'root'});
  root.children = [teamA, teamB];
  teamA.parentNode = root;
  teamB.parentNode = root;
  return {root, workerA, workerB};
}

/** The reference's bare `BaseNode(name='orphan')`. */
function orphan(): ParentNode {
  return new ParentNode({name: 'orphan'});
}

describe('find_static_node_path', () => {
  it('test_find_static_node_path_returns_root_path_for_root', () => {
    const {root} = buildTree();
    expect(findStaticNodePath(root, root)).toBe('root');
  });

  it('test_find_static_node_path_disambiguates_same_name_nodes', () => {
    const {root, workerA, workerB} = buildTree();
    // The reference asserts 'root/team_a/worker'; adk-js joins with '.'.
    expect(findStaticNodePath(root, workerA)).toBe('root.team_a.worker');
    expect(findStaticNodePath(root, workerB)).toBe('root.team_b.worker');
  });

  it('test_find_static_node_path_handles_cycles_and_back_references', () => {
    const {root, workerA, workerB} = buildTree();
    workerA.children.push(root);

    expect(findStaticNodePath(root, workerA)).toBe('root.team_a.worker');
    expect(findStaticNodePath(root, workerB)).toBe('root.team_b.worker');
    expect(findStaticNodePath(root, orphan())).toBeUndefined();
  });

  it('test_find_static_node_path_returns_none_for_unreachable_node', () => {
    const {root} = buildTree();
    expect(findStaticNodePath(root, orphan())).toBeUndefined();
  });
});
