/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, RunnableRoot} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {AgentInfo, BaseAgentLoader} from '../../src/utils/base_agent_loader.js';

/** Implements only the two abstract members, so the defaults stay in place. */
class NamesOnlyLoader extends BaseAgentLoader {
  constructor(private readonly names: string[]) {
    super();
  }

  async listAgents(): Promise<string[]> {
    return this.names;
  }

  async loadAgent(agentName: string): Promise<RunnableRoot> {
    return new LlmAgent({name: agentName});
  }
}

/** Describes its agents without loading them, so it overrides the default. */
class DescribingLoader extends NamesOnlyLoader {
  override async listAgentsDetailed(): Promise<AgentInfo[]> {
    const names = await this.listAgents();

    return names.map((name) => ({
      name,
      displayName: `${name} agent`,
      description: `describes ${name}`,
      type: 'llm',
    }));
  }
}

describe('BaseAgentLoader', () => {
  describe('listAgentsDetailed', () => {
    it('maps every name to an entry, in the order listAgents returned', async () => {
      const loader = new NamesOnlyLoader(['a', 'b']);

      expect(await loader.listAgentsDetailed()).toEqual([
        {name: 'a'},
        {name: 'b'},
      ]);
    });

    it('reports no entries when there are no agents', async () => {
      const loader = new NamesOnlyLoader([]);

      expect(await loader.listAgentsDetailed()).toEqual([]);
    });

    it('lets a subclass replace the default with its own metadata', async () => {
      const loader = new DescribingLoader(['a']);

      expect(await loader.listAgentsDetailed()).toEqual([
        {
          name: 'a',
          displayName: 'a agent',
          description: 'describes a',
          type: 'llm',
        },
      ]);
    });
  });

  describe('loadAgent', () => {
    it('serves the agent a subclass resolves for the name', async () => {
      const loader = new NamesOnlyLoader(['a']);

      expect((await loader.loadAgent('a')).name).toBe('a');
    });
  });
});
