/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseNode} from '../../src/workflow/base_node.js';
import {findStaticNodePath} from '../../src/workflow/utils/node_path_utils.js';
import {FnNode} from './test_helpers.js';

/** A node holding one arbitrary value, to exercise child discovery. */
class ContainerNode extends BaseNode {
  constructor(
    name: string,
    readonly held: unknown,
  ) {
    super({name});
  }

  protected runImpl(): AsyncGenerator<never, void, void> {
    throw new Error('not executed');
  }
}

describe('findStaticNodePath', () => {
  const leaf = () => new FnNode('leaf', (_c, i) => i);

  it('finds a child held directly on a property', () => {
    const child = leaf();
    expect(findStaticNodePath(new ContainerNode('root', child), child)).toBe(
      'root.leaf',
    );
  });

  it('finds a child held in an array, a Set, a Map or a plain object', () => {
    for (const wrap of [
      (n: BaseNode) => [n],
      (n: BaseNode) => new Set([n]),
      (n: BaseNode) => new Map([['a', n]]),
      (n: BaseNode) => ({a: n}),
    ]) {
      const child = leaf();
      const root = new ContainerNode('root', wrap(child));
      expect(findStaticNodePath(root, child)).toBe('root.leaf');
    }
  });

  it('does not find a node nested two containers deep', () => {
    const child = leaf();
    const root = new ContainerNode('root', [[child]]);
    expect(findStaticNodePath(root, child)).toBeUndefined();
  });
});
