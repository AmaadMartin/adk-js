/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  canTransferBetweenAgents,
  Event,
  getTransferTargets,
  InvocationContext,
  LlmAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A parent with no model, so it has nothing to route a transfer with. */
class SilentAgent extends BaseAgent {
  protected override async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}

  protected override async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function agent(name: string, subAgents: BaseAgent[] = []): LlmAgent {
  return new LlmAgent({name, model: 'gemini-2.5-flash', subAgents});
}

describe('getTransferTargets', () => {
  it('reaches every sub-agent', () => {
    const child = agent('child');
    const other = agent('other');
    const root = agent('root', [child, other]);

    expect(getTransferTargets(root).map((a) => a.name)).toEqual([
      'child',
      'other',
    ]);
  });

  it('reaches the parent and the peers under it', () => {
    const child = agent('child');
    const peer = agent('peer');
    agent('root', [child, peer]);

    expect(getTransferTargets(child).map((a) => a.name)).toEqual([
      'root',
      'peer',
    ]);
  });

  it('skips the parent when the agent disallows it', () => {
    const child = new LlmAgent({
      name: 'child',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
    });
    const peer = agent('peer');
    agent('root', [child, peer]);

    expect(getTransferTargets(child).map((a) => a.name)).toEqual(['peer']);
  });

  it('skips the peers when the agent disallows them', () => {
    const child = new LlmAgent({
      name: 'child',
      model: 'gemini-2.5-flash',
      disallowTransferToPeers: true,
    });
    const peer = agent('peer');
    agent('root', [child, peer]);

    expect(getTransferTargets(child).map((a) => a.name)).toEqual(['root']);
  });

  it('reaches nothing through a parent that is not an LlmAgent', () => {
    const child = agent('child');
    new SilentAgent({name: 'workflow', subAgents: [child]});

    expect(getTransferTargets(child)).toEqual([]);
  });
});

describe('canTransferBetweenAgents', () => {
  it('is false for a lone agent', () => {
    expect(canTransferBetweenAgents(agent('solo'))).toBe(false);
  });

  it('is true for a root that has sub-agents', () => {
    expect(canTransferBetweenAgents(agent('root', [agent('child')]))).toBe(
      true,
    );
  });

  it('is true for a transfer target two levels down', () => {
    const grandchild = agent('grandchild');
    const child = new LlmAgent({
      name: 'child',
      model: 'gemini-2.5-flash',
      subAgents: [grandchild],
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });
    const workflow = new SilentAgent({name: 'workflow', subAgents: [child]});

    expect(canTransferBetweenAgents(workflow)).toBe(true);
  });

  it('is false when every agent in the tree refuses every direction', () => {
    const child = new LlmAgent({
      name: 'child',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });
    const workflow = new SilentAgent({name: 'workflow', subAgents: [child]});

    expect(canTransferBetweenAgents(workflow)).toBe(false);
  });

  it('is false for a value that is not an agent', () => {
    expect(canTransferBetweenAgents({name: 'not an agent'})).toBe(false);
  });
});
