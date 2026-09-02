/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  canTransferBetweenAgents,
  getTransferTargets,
  LlmAgent,
  node,
  SequentialAgent,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function agent(name: string, subAgents: BaseAgent[] = []): LlmAgent {
  return new LlmAgent({name, model: 'gemini-2.0-flash', subAgents});
}

function names(agents: BaseAgent[]): string[] {
  return agents.map((a) => a.name);
}

describe('getTransferTargets', () => {
  it('always offers the sub-agents', () => {
    const root = agent('root', [agent('a'), agent('b')]);

    expect(names(getTransferTargets(root))).toEqual(['a', 'b']);
  });

  it('offers the parent and the peers of a sub-agent', () => {
    const child = agent('child');
    agent('root', [child, agent('peer')]);

    expect(names(getTransferTargets(child))).toEqual(['root', 'peer']);
  });

  it('withholds the parent when the child disallows it', () => {
    const child = new LlmAgent({
      name: 'child',
      model: 'gemini-2.0-flash',
      disallowTransferToParent: true,
    });
    agent('root', [child, agent('peer')]);

    expect(names(getTransferTargets(child))).toEqual(['peer']);
  });

  it('withholds the peers when the child disallows them', () => {
    const child = new LlmAgent({
      name: 'child',
      model: 'gemini-2.0-flash',
      disallowTransferToPeers: true,
    });
    agent('root', [child, agent('peer')]);

    expect(names(getTransferTargets(child))).toEqual(['root']);
  });

  it('offers nothing through a parent that is not an LlmAgent', () => {
    const child = agent('child');
    new SequentialAgent({name: 'root', subAgents: [child, agent('peer')]});

    expect(getTransferTargets(child)).toEqual([]);
  });
});

describe('canTransferBetweenAgents', () => {
  it('reports a coordinator with sub-agents', () => {
    expect(canTransferBetweenAgents(agent('root', [agent('a')]))).toBe(true);
  });

  it('reports a lone agent as unable to transfer', () => {
    expect(canTransferBetweenAgents(agent('root'))).toBe(false);
  });

  it('finds a transferable agent below a workflow agent', () => {
    const root = new SequentialAgent({
      name: 'root',
      subAgents: [
        new SequentialAgent({name: 'mid', subAgents: [agent('leaf')]}),
      ],
    });

    // The leaf has no sub-agents of its own, so `mid` is what makes it
    // transferable: the walk has to reach the leaf's parent to see that.
    expect(canTransferBetweenAgents(root)).toBe(false);

    const withPeer = new SequentialAgent({
      name: 'root2',
      subAgents: [agent('mid2', [agent('leaf2')])],
    });
    expect(canTransferBetweenAgents(withPeer)).toBe(true);
  });

  it('reports a workflow root as unable to transfer', () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', node(() => 'done', {name: 'step'})]],
    });

    expect(canTransferBetweenAgents(workflow)).toBe(false);
  });
});
