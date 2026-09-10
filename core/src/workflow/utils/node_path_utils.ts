/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseNode, isBaseNode} from '../base_node.js';
import {isPlainObject} from './workflow_graph_utils.js';

/**
 * Returns the static path of `target` within the node tree rooted at `root`,
 * or `undefined` when `target` is not reachable from it.
 *
 * The path is the chain of node names from `root` down to `target` inclusive,
 * carrying no run ids, so it names a node's position in the tree independently
 * of any run. Two nodes sharing a name are told apart by their parents.
 *
 * The segments are joined with `.`, where `google/adk-python`
 * `workflow/_base_node.py::find_static_node_path` joins with `/`. Every path
 * adk-js emits is dot-separated (see `BranchPath` and the node runner's
 * `nodePath`), and a `/`-joined path would not compare against them.
 *
 * Children are found through the node's own enumerable properties, one
 * container level deep, so a node reachable only through a wrapper object —
 * a `Workflow`'s graph, for instance — is not found. The reference has the
 * same blind spot.
 */
export function findStaticNodePath(
  root: BaseNode,
  target: BaseNode,
): string | undefined {
  return collectNodePath(root, target, new Set<BaseNode>())?.join('.');
}

/**
 * Depth-first search for `target` under `curr`, returning the node names along
 * the way. `visited` keeps a cyclic graph terminating.
 */
function collectNodePath(
  curr: BaseNode,
  target: BaseNode,
  visited: Set<BaseNode>,
): string[] | undefined {
  if (visited.has(curr)) {
    return undefined;
  }
  visited.add(curr);
  if (curr === target) {
    return [curr.name];
  }
  const values: unknown[] = Object.values(curr);
  for (const value of values) {
    for (const child of directChildNodes(value)) {
      const path = collectNodePath(child, target, visited);
      if (path) {
        return [curr.name, ...path];
      }
    }
  }
  return undefined;
}

/**
 * Returns the nodes `value` holds directly: `value` itself when it is a node,
 * or the nodes inside one array, `Set`, `Map` or plain object. Nested
 * containers are not descended into.
 */
function directChildNodes(value: unknown): BaseNode[] {
  if (isBaseNode(value)) {
    return [value];
  }
  if (Array.isArray(value) || value instanceof Set) {
    const items: unknown[] = [...value];
    return items.filter(isBaseNode);
  }
  if (value instanceof Map) {
    const items: unknown[] = [...value.values()];
    return items.filter(isBaseNode);
  }
  if (isPlainObject(value)) {
    const items: unknown[] = Object.values(value);
    return items.filter(isBaseNode);
  }
  return [];
}
