/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {resolveTransferTarget} from '../../src/agents/transfer_utils.js';

/** An agent with no `disallowTransferToPeers` field to enforce. */
class NonLlmAgent extends BaseAgent {
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

/** Builds `root` with peers `child1` and `child2`, with parents wired. */
function createAgentTree(child1Options: {disallowTransferToPeers?: boolean}) {
  const child1 = new LlmAgent({
    name: 'child1',
    disallowTransferToPeers: child1Options.disallowTransferToPeers,
  });
  const child2 = new LlmAgent({name: 'child2'});
  const root = new LlmAgent({name: 'root', subAgents: [child1, child2]});
  return {root, child1, child2};
}

describe('resolveTransferTarget', () => {
  it('rejects a sibling when the caller disallows transfer to peers', () => {
    const {child1} = createAgentTree({disallowTransferToPeers: true});
    const invocationContext = createInvocationContext(child1);

    expect(() => resolveTransferTarget(invocationContext, 'child2')).toThrow(
      /Transfer to sibling agent child2 is disallowed/,
    );
  });

  it('returns a sibling when the caller allows transfer to peers', () => {
    const {child1, child2} = createAgentTree({disallowTransferToPeers: false});
    const invocationContext = createInvocationContext(child1);

    expect(resolveTransferTarget(invocationContext, 'child2')).toBe(child2);
  });

  it('rejects a name that is not in the agent tree', () => {
    const {child1} = createAgentTree({});
    const invocationContext = createInvocationContext(child1);

    expect(() =>
      resolveTransferTarget(invocationContext, 'not_in_tree'),
    ).toThrow(/Agent not_in_tree not found in the agent tree/);
  });

  it('returns the caller itself when peers are disallowed', () => {
    const {child1} = createAgentTree({disallowTransferToPeers: true});
    const invocationContext = createInvocationContext(child1);

    expect(resolveTransferTarget(invocationContext, 'child1')).toBe(child1);
  });

  it('returns a sibling when the caller is not an LlmAgent', () => {
    const child1 = new NonLlmAgent({name: 'child1'});
    const child2 = new LlmAgent({name: 'child2'});
    new LlmAgent({name: 'root', subAgents: [child1, child2]});
    const invocationContext = createInvocationContext(child1);

    expect(resolveTransferTarget(invocationContext, 'child2')).toBe(child2);
  });

  it('returns the parent when peers are disallowed', () => {
    const {root, child1} = createAgentTree({disallowTransferToPeers: true});
    const invocationContext = createInvocationContext(child1);

    expect(resolveTransferTarget(invocationContext, 'root')).toBe(root);
  });

  it('returns a sub-agent of the caller when peers are disallowed', () => {
    const grandChild = new LlmAgent({name: 'grand_child'});
    const child1 = new LlmAgent({
      name: 'child1',
      disallowTransferToPeers: true,
      subAgents: [grandChild],
    });
    const child2 = new LlmAgent({name: 'child2'});
    new LlmAgent({name: 'root', subAgents: [child1, child2]});
    const invocationContext = createInvocationContext(child1);

    expect(resolveTransferTarget(invocationContext, 'grand_child')).toBe(
      grandChild,
    );
  });

  it('returns the root when the root transfers to itself', () => {
    const {root} = createAgentTree({});
    root.disallowTransferToPeers = true;
    const invocationContext = createInvocationContext(root);

    expect(resolveTransferTarget(invocationContext, 'root')).toBe(root);
  });
});
