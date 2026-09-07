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
  LlmAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A non-LlmAgent parent, which has no transfer tool to be reached through. */
class PlainAgent extends BaseAgent {
  protected override async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    yield* [];
  }

  protected override async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    yield* [];
  }
}

function llmAgent(
  name: string,
  options: {
    subAgents?: BaseAgent[];
    disallowTransferToParent?: boolean;
    disallowTransferToPeers?: boolean;
  } = {},
): LlmAgent {
  return new LlmAgent({
    name,
    model: 'gemini-2.5-flash',
    subAgents: options.subAgents ?? [],
    disallowTransferToParent: options.disallowTransferToParent,
    disallowTransferToPeers: options.disallowTransferToPeers,
  });
}

describe('getTransferTargets', () => {
  it('always includes the sub-agents', () => {
    const child = llmAgent('child');
    const root = llmAgent('root', {subAgents: [child]});

    expect(getTransferTargets(root).map((a) => a.name)).toEqual(['child']);
  });

  it('includes the parent and the peers of a nested agent', () => {
    const first = llmAgent('first');
    const second = llmAgent('second');
    llmAgent('root', {subAgents: [first, second]});

    expect(getTransferTargets(first).map((a) => a.name)).toEqual([
      'root',
      'second',
    ]);
  });

  it('omits the parent when the agent disallows transfer to it', () => {
    const first = llmAgent('first', {disallowTransferToParent: true});
    const second = llmAgent('second');
    llmAgent('root', {subAgents: [first, second]});

    expect(getTransferTargets(first).map((a) => a.name)).toEqual(['second']);
  });

  it('omits the peers when the agent disallows transfer to them', () => {
    const first = llmAgent('first', {disallowTransferToPeers: true});
    const second = llmAgent('second');
    llmAgent('root', {subAgents: [first, second]});

    expect(getTransferTargets(first).map((a) => a.name)).toEqual(['root']);
  });

  it('returns nothing for an agent under a parent that is not an LlmAgent', () => {
    const child = llmAgent('child');
    new PlainAgent({name: 'pipeline', subAgents: [child]});

    expect(getTransferTargets(child)).toEqual([]);
  });
});

describe('canTransferBetweenAgents', () => {
  it('reports a multi-agent tree as transferable', () => {
    const root = llmAgent('root', {subAgents: [llmAgent('child')]});

    expect(canTransferBetweenAgents(root)).toBe(true);
  });

  it('reports a lone agent as not transferable', () => {
    expect(canTransferBetweenAgents(llmAgent('root'))).toBe(false);
  });

  it('finds a transferable pair nested under a non-LlmAgent root', () => {
    const nested = llmAgent('nested', {subAgents: [llmAgent('leaf')]});
    const root = new PlainAgent({name: 'pipeline', subAgents: [nested]});

    expect(canTransferBetweenAgents(root)).toBe(true);
  });

  it('reports a tree of non-LlmAgents as not transferable', () => {
    const root = new PlainAgent({
      name: 'pipeline',
      subAgents: [new PlainAgent({name: 'inner', subAgents: []})],
    });

    expect(canTransferBetweenAgents(root)).toBe(false);
  });
});
