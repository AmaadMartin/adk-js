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

const AGENT_ENV_KEY = 'ADK_TEST_AGENT_ENV';

/**
 * Reads the environment variable while the module is imported, so the agent
 * name proves the `.env` was loaded before the import and not after it.
 * `isBaseAgent` accepts any object carrying this global marker, which keeps the
 * fixture free of workspace imports and of a build step.
 */
const AGENT_MODULE = `export const rootAgent = {
  [Symbol.for('google.adk.baseAgent')]: true,
  name: process.env.${AGENT_ENV_KEY} ?? 'unset',
};
`;

describe('AgentLoader .env loading', () => {
  let tmpDir: string;
  let agentsDir: string;
  let savedEnv: Record<string, string | undefined>;
  let loader: AgentLoader | undefined;

  beforeEach(async () => {
    savedEnv = {...process.env};
    delete process.env[AGENT_ENV_KEY];
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-loader-envs-'));
    agentsDir = path.join(tmpDir, 'agents');
    await fs.mkdir(agentsDir, {recursive: true});
  });

  afterEach(async () => {
    await loader?.disposeAll();
    loader = undefined;
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    await fs.rm(tmpDir, {recursive: true, force: true});
  });

  async function writeAgentFolder(name: string): Promise<string> {
    const folder = path.join(agentsDir, name);
    await fs.mkdir(folder, {recursive: true});
    await fs.writeFile(path.join(folder, 'agent.mjs'), AGENT_MODULE);
    return folder;
  }

  async function loadAgent(name: string) {
    loader = new AgentLoader(agentsDir, {compile: false, bundle: false});
    const agentFile = await loader.getAgentFile(name);
    return agentFile.loadAgent();
  }

  it('gives each agent its own .env when it loads them together', async () => {
    const names = ['alpha', 'bravo', 'charlie'];
    for (const name of names) {
      const folder = await writeAgentFolder(name);
      await fs.writeFile(
        path.join(folder, '.env'),
        `${AGENT_ENV_KEY}=from-${name}\n`,
      );
    }
    loader = new AgentLoader(agentsDir, {compile: false, bundle: false});

    await loader.preloadAgents();

    for (const name of names) {
      const agentFile = await loader.getAgentFile(name);
      const agent = await agentFile.loadAgent();
      expect(agent.name).toBe(`from-${name}`);
    }
  });

  it('applies the agent folder .env before importing the agent', async () => {
    const folder = await writeAgentFolder('agent1');
    await fs.writeFile(
      path.join(folder, '.env'),
      `${AGENT_ENV_KEY}=from-agent-dotenv\n`,
    );

    const agent = await loadAgent('agent1');

    expect(agent.name).toBe('from-agent-dotenv');
  });

  it('applies a .env from the agents folder', async () => {
    await writeAgentFolder('agent1');
    await fs.writeFile(
      path.join(agentsDir, '.env'),
      `${AGENT_ENV_KEY}=from-agents-dotenv\n`,
    );

    const agent = await loadAgent('agent1');

    expect(agent.name).toBe('from-agents-dotenv');
  });

  it('applies a .env for an agent stored as a single file', async () => {
    await fs.writeFile(path.join(agentsDir, 'agent1.mjs'), AGENT_MODULE);
    await fs.writeFile(
      path.join(agentsDir, '.env'),
      `${AGENT_ENV_KEY}=from-flat-layout\n`,
    );

    const agent = await loadAgent('agent1');

    expect(agent.name).toBe('from-flat-layout');
  });
});
