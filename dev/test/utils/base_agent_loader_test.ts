/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, LlmAgent, RunnableRoot} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {AgentLoader} from '../../src/utils/agent_loader.js';
import {BaseAgentLoader} from '../../src/utils/base_agent_loader.js';

/** A loader that knows the names and nothing else. */
class NamesOnlyLoader extends BaseAgentLoader {
  constructor(private readonly names: string[]) {
    super();
  }

  async loadAgent(agentName: string): Promise<RunnableRoot | App> {
    return new LlmAgent({name: agentName});
  }

  async listAgents(): Promise<string[]> {
    return this.names;
  }
}

/**
 * An agent module that pulls in nothing.
 *
 * `Symbol.for('google.adk.baseAgent')` is the signature `isBaseAgent` reads, so
 * the loader accepts this file without a bundler step.
 */
function agentModuleSource(name: string): string {
  return `export const rootAgent = {
  name: ${JSON.stringify(name)},
  [Symbol.for('google.adk.baseAgent')]: true,
};
`;
}

describe('BaseAgentLoader', () => {
  describe('listAgentsDetailed', () => {
    it('reports one entry per name, with no metadata', async () => {
      const loader = new NamesOnlyLoader(['beta', 'alpha']);

      expect(await loader.listAgentsDetailed()).toEqual([
        {name: 'beta', displayName: null, description: null, type: null},
        {name: 'alpha', displayName: null, description: null, type: null},
      ]);
    });

    it('reports nothing when the loader holds no agents', async () => {
      const loader = new NamesOnlyLoader([]);

      expect(await loader.listAgentsDetailed()).toEqual([]);
    });
  });
});

describe('AgentLoader as a BaseAgentLoader', () => {
  let agentsDir: string;
  let loader: AgentLoader;

  beforeEach(async () => {
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-base-loader-'));
    await fs.writeFile(
      path.join(agentsDir, 'agent_one.mjs'),
      agentModuleSource('agent_one'),
    );
    await fs.writeFile(
      path.join(agentsDir, 'agent_two.mjs'),
      agentModuleSource('agent_two'),
    );

    // The fixtures need no transpiling, so the compile step stays off and the
    // loader imports them as they are.
    loader = new AgentLoader(agentsDir, {compile: false, bundle: false});
  });

  afterEach(async () => {
    await loader.disposeAll();
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  it('loads the same root the agent file loads', async () => {
    const viaContract = await loader.loadAgent('agent_one');
    const viaAgentFile = await (await loader.getAgentFile('agent_one')).load();

    expect(viaContract).toBe(viaAgentFile);
    expect(viaContract.name).toBe('agent_one');
  });

  it('reports the failure when the agent is unknown', async () => {
    await expect(loader.loadAgent('missing')).rejects.toThrow(
      /Agent 'missing' not found/,
    );
  });

  it('inherits listAgentsDetailed from the contract', async () => {
    const contract: BaseAgentLoader = loader;

    expect(await contract.listAgentsDetailed()).toEqual([
      {name: 'agent_one', displayName: null, description: null, type: null},
      {name: 'agent_two', displayName: null, description: null, type: null},
    ]);
  });
});
