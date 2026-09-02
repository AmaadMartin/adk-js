/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  getTransferTargets,
  LlmAgent,
  SequentialAgent,
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
