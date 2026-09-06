/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` at `main`:
 * `tests/unittests/workflow/test_base_node.py`. All four reference tests are
 * here, and the `it(...)` strings keep the Python test names verbatim so the
 * two suites stay greppable against each other.
 *
 * Two adaptations, and no others:
 *  - adk-js's `BaseNode` is abstract, so the fixture uses a concrete subclass
 *    carrying `children` and `parentNode` where Python instantiates `BaseNode`
 *    with extra Pydantic fields.
 *  - a path segment is joined with `.`, not `/` (see `findStaticNodePath`).
 */

import {describe, expect, it} from 'vitest';
import {BaseNode} from '../../src/workflow/base_node.js';
import {findStaticNodePath} from '../../src/workflow/utils/node_path_utils.js';
import {FnNode} from './test_helpers.js';

/**
 * The reference's `_Parent` fixture: a node holding children and a parent, as
 * own enumerable properties. `BaseNode` is abstract in TypeScript, so this
 * extends the concrete `FnNode` rather than `BaseNode` itself.
 */
class ParentNode extends FnNode {
  parentNode?: BaseNode;

  constructor(
    name: string,
    readonly children: BaseNode[] = [],
  ) {
    super(name, (_ctx, input) => input);
  }
}

/** root -> (team_a -> worker), (team_b -> worker): two nodes named 'worker'. */
function buildTree(): {
  root: BaseNode;
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

/** The reference builds its orphan as a bare BaseNode, which is abstract here. */
function orphanNode(): BaseNode {
  return new FnNode('orphan', (_ctx, input) => input);
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
    expect(findStaticNodePath(root, orphanNode())).toBeUndefined();
  });

  it('test_find_static_node_path_returns_none_for_unreachable_node', () => {
    const {root} = buildTree();
    expect(findStaticNodePath(root, orphanNode())).toBeUndefined();
  });
});
