/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {AgentLoader} from '../../src/utils/agent_loader.js';
import type {BaseAgentLoader} from '../../src/utils/base_agent_loader.js';

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

describe('AgentLoader as a BaseAgentLoader', () => {
  let agentsDir: string;
  let agentLoader: AgentLoader;
  /** The same loader seen through the contract, so only its methods are used. */
  let contract: BaseAgentLoader;

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
    agentLoader = new AgentLoader(agentsDir, {compile: false, bundle: false});
    contract = agentLoader;
  });

  afterEach(async () => {
    await agentLoader.disposeAll();
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  it('loads the same root the agent file loads', async () => {
    const viaContract = await contract.loadAgent('agent_one');
    const viaAgentFile = await (
      await agentLoader.getAgentFile('agent_one')
    ).load();

    expect(viaContract).toBe(viaAgentFile);
    expect(viaContract.name).toBe('agent_one');
  });

  it('reports the failure when the agent is unknown', async () => {
    await expect(contract.loadAgent('missing')).rejects.toThrow(
      /Agent 'missing' not found/,
    );
  });

  it('lists every agent in the directory', async () => {
    expect(await contract.listAgents()).toEqual(['agent_one', 'agent_two']);
  });
});
