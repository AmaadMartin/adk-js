/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the transfer resolver, the TypeScript counterpart of
 * `google/adk-python` `workflow/utils/_transfer_utils.py`. The reference suite
 * covers the resolver only through `Context.run_node`
 * (`tests/unittests/agents/test_context.py`); these exercise it directly, so a
 * routing case that no transfer test happens to reach is still pinned.
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {
  MAX_PARENT_DEPTH,
  resolveAndDeriveTransferContext,
} from '../../src/workflow/utils/transfer_utils.js';
import {createIc} from './test_helpers.js';

let ic: InvocationContext;
let channel: AsyncQueue<Event>;

beforeEach(() => {
  ic = createIc();
  channel = new AsyncQueue<Event>();
});

function makeCtx(node?: BaseNode, parentCtx?: NodeContext): NodeContext {
  return new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: node?.name ?? '',
    runId: '1',
    node,
    parentCtx,
  });
}

function agent(
  name: string,
  subAgents: BaseAgent[] = [],
  config: {
    disallowTransferToPeers?: boolean;
    disallowTransferToParent?: boolean;
  } = {},
): LlmAgent {
  return new LlmAgent({name, subAgents, ...config});
}

describe('resolveAndDeriveTransferContext', () => {
  it('rejects a target the tree does not hold', () => {
    const only = agent('only');
    const ctx = makeCtx(only);

    expect(() =>
      resolveAndDeriveTransferContext({
        targetName: 'ghost',
        currentAgent: only,
        rootAgent: only,
        currCtx: ctx,
        currParentCtx: ctx,
      }),
    ).toThrow("Transfer target agent 'ghost' not found.");
  });

  it('rejects an agent transferring to itself', () => {
    const self = agent('self');
    const ctx = makeCtx(self);

    expect(() =>
      resolveAndDeriveTransferContext({
        targetName: 'self',
        currentAgent: self,
        rootAgent: self,
        currCtx: ctx,
        currParentCtx: ctx,
      }),
    ).toThrow("Agent 'self' cannot transfer to itself.");
  });

  it('runs a child under the current context', () => {
    const child = agent('child');
    const parent = agent('parent', [child]);
    const parentCtx = makeCtx(parent);
    const currCtx = makeCtx(parent, parentCtx);

    expect(
      resolveAndDeriveTransferContext({
        targetName: 'child',
        currentAgent: parent,
        rootAgent: parent,
        currCtx,
        currParentCtx: parentCtx,
      }),
    ).toEqual({targetAgent: child, nextParentCtx: currCtx});
  });

  it('runs a sibling under the shared parent context', () => {
    const left = agent('left');
    const right = agent('right');
    const root = agent('root', [left, right]);
    const rootCtx = makeCtx(root);
    const currCtx = makeCtx(left, rootCtx);

    expect(
      resolveAndDeriveTransferContext({
        targetName: 'right',
        currentAgent: left,
        rootAgent: root,
        currCtx,
        currParentCtx: rootCtx,
      }),
    ).toEqual({targetAgent: right, nextParentCtx: rootCtx});
  });

  it('rejects a sibling transfer when disallowTransferToPeers is set', () => {
    const left = agent('left', [], {disallowTransferToPeers: true});
    const right = agent('right');
    const root = agent('root', [left, right]);
    const rootCtx = makeCtx(root);

    expect(() =>
      resolveAndDeriveTransferContext({
        targetName: 'right',
        currentAgent: left,
        rootAgent: root,
        currCtx: makeCtx(left, rootCtx),
        currParentCtx: rootCtx,
      }),
    ).toThrow(
      "Cannot transfer from 'left' to peer agent 'right': " +
        'disallowTransferToPeers is set.',
    );
  });

  it('runs a parent under the context that ran it', () => {
    const child = agent('child');
    const parent = agent('parent', [child]);
    const root = agent('root', [parent]);
    const rootCtx = makeCtx(root);
    const parentCtx = makeCtx(parent, rootCtx);
    const childCtx = makeCtx(child, parentCtx);

    expect(
      resolveAndDeriveTransferContext({
        targetName: 'parent',
        currentAgent: child,
        rootAgent: root,
        currCtx: childCtx,
        currParentCtx: parentCtx,
      }),
    ).toEqual({targetAgent: parent, nextParentCtx: rootCtx});
  });

  it('rejects a parent transfer when disallowTransferToParent is set', () => {
    const child = agent('child', [], {disallowTransferToParent: true});
    const parent = agent('parent', [child]);
    const parentCtx = makeCtx(parent);

    expect(() =>
      resolveAndDeriveTransferContext({
        targetName: 'parent',
        currentAgent: child,
        rootAgent: parent,
        currCtx: makeCtx(child, parentCtx),
        currParentCtx: parentCtx,
      }),
    ).toThrow(
      "Cannot transfer from 'child' to parent agent 'parent': " +
        'disallowTransferToParent is set.',
    );
  });

  it('falls back to the outermost context when the parent never ran one', () => {
    const child = agent('child');
    const parent = agent('parent', [child]);
    // The parent was bypassed: no context on the chain belongs to it.
    const rootCtx = makeCtx();
    const childCtx = makeCtx(child, rootCtx);

    expect(
      resolveAndDeriveTransferContext({
        targetName: 'parent',
        currentAgent: child,
        rootAgent: parent,
        currCtx: childCtx,
        currParentCtx: rootCtx,
      }),
    ).toEqual({targetAgent: parent, nextParentCtx: rootCtx});
  });

  it('rejects a target with no routing relationship, and lists the names', () => {
    const nephew = agent('nephew');
    const uncle = agent('uncle', [nephew]);
    const stranger = agent('stranger');
    const root = agent('root', [stranger, uncle]);
    const rootCtx = makeCtx(root);

    expect(() =>
      resolveAndDeriveTransferContext({
        targetName: 'nephew',
        currentAgent: stranger,
        rootAgent: root,
        currCtx: makeCtx(stranger, rootCtx),
        currParentCtx: rootCtx,
      }),
    ).toThrow(
      "Cannot transfer from 'stranger' to unrelated agent 'nephew'.\n" +
        'Available agents: root, stranger, uncle, nephew',
    );
  });

  it('stops walking the context chain at the depth cap', () => {
    const child = agent('child');
    const parent = agent('parent', [child]);

    // A chain far deeper than the cap, with no context belonging to the target.
    const chain: NodeContext[] = [makeCtx(child)];
    for (let depth = 1; depth <= MAX_PARENT_DEPTH + 10; depth++) {
      chain.push(makeCtx(child, chain[depth - 1]));
    }
    const deepest = chain[chain.length - 1];

    const {nextParentCtx} = resolveAndDeriveTransferContext({
      targetName: 'parent',
      currentAgent: child,
      rootAgent: parent,
      currCtx: deepest,
      currParentCtx: chain[chain.length - 2],
    });

    // The fallback walk gave up at the cap rather than reaching chain[0].
    expect(nextParentCtx).toBe(chain[chain.length - 1 - MAX_PARENT_DEPTH]);
    expect(nextParentCtx).not.toBe(chain[0]);
  });
});
