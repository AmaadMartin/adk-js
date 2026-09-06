/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const EXPLICIT_KEY = 'ADK_TEST_EXPLICIT_ENV';
const DOTENV_KEY = 'ADK_TEST_FROM_DOTENV';
const DISABLE_FLAG = 'ADK_DISABLE_LOAD_DOTENV';

/**
 * Budget (ms) for every test here. `vi.resetModules()` makes the next import
 * re-evaluate the whole `@google/adk` source graph, and that cold import
 * passed Vitest's 5s default on a macOS CI runner.
 */
const TEST_TIMEOUT_MS = 30000;

/**
 * Re-imports the module so it forgets which keys a `.env` supplied, the way a
 * fresh process starts with none.
 */
async function importEnvs() {
  vi.resetModules();
  return import('../../src/utils/envs.js');
}

describe('envs', {timeout: TEST_TIMEOUT_MS}, () => {
  let tmpDir: string;
  let agentsDir: string;
  let agentDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = {...process.env};
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-envs-'));
    agentsDir = path.join(tmpDir, 'agents');
    agentDir = path.join(agentsDir, 'agent1');
    await fs.mkdir(agentDir, {recursive: true});
    delete process.env[EXPLICIT_KEY];
    delete process.env[DOTENV_KEY];
    delete process.env[DISABLE_FLAG];
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    await fs.rm(tmpDir, {recursive: true, force: true});
  });

  async function writeEnvFile(folder: string, contents: string): Promise<void> {
    await fs.writeFile(path.join(folder, '.env'), contents);
  }

  it('preserves an explicitly set variable', async () => {
    process.env[EXPLICIT_KEY] = 'explicit';
    await writeEnvFile(
      agentDir,
      `${EXPLICIT_KEY}=from_dotenv\n${DOTENV_KEY}=from_dotenv\n`,
    );
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);

    expect(process.env[EXPLICIT_KEY]).toBe('explicit');
    expect(process.env[DOTENV_KEY]).toBe('from_dotenv');
  });

  it('lets a later .env override an earlier one', async () => {
    const agent2Dir = path.join(agentsDir, 'agent2');
    await fs.mkdir(agent2Dir);
    await writeEnvFile(agentDir, `${DOTENV_KEY}=one\n`);
    await writeEnvFile(agent2Dir, `${DOTENV_KEY}=two\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);
    expect(process.env[DOTENV_KEY]).toBe('one');

    loadDotenvForAgent(agent2Dir);
    expect(process.env[DOTENV_KEY]).toBe('two');
  });

  it('lets an agent .env override the working directory one', async () => {
    await writeEnvFile(tmpDir, `${DOTENV_KEY}=from_working_directory\n`);
    await writeEnvFile(agentDir, `${DOTENV_KEY}=from_agent\n`);
    const {loadDotenvForAgent} = await importEnvs();

    // The calls `cli.ts` and `AgentLoader` make, in that order.
    loadDotenvForAgent(tmpDir);
    expect(process.env[DOTENV_KEY]).toBe('from_working_directory');

    loadDotenvForAgent(agentDir);
    expect(process.env[DOTENV_KEY]).toBe('from_agent');
  });

  it('does not restore an explicit variable the caller deleted', async () => {
    const agent2Dir = path.join(agentsDir, 'agent2');
    await fs.mkdir(agent2Dir);
    process.env[EXPLICIT_KEY] = 'explicit';
    await writeEnvFile(agentDir, `${DOTENV_KEY}=one\n`);
    await writeEnvFile(agent2Dir, `${DOTENV_KEY}=two\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);
    delete process.env[EXPLICIT_KEY];
    loadDotenvForAgent(agent2Dir);

    expect(process.env[EXPLICIT_KEY]).toBeUndefined();
    expect(process.env[DOTENV_KEY]).toBe('two');
  });

  it('lets a .env supply an explicit variable the caller deleted', async () => {
    const agent2Dir = path.join(agentsDir, 'agent2');
    await fs.mkdir(agent2Dir);
    process.env[EXPLICIT_KEY] = 'explicit';
    await writeEnvFile(agentDir, `${DOTENV_KEY}=one\n`);
    await writeEnvFile(agent2Dir, `${EXPLICIT_KEY}=from_dotenv\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);
    delete process.env[EXPLICIT_KEY];
    loadDotenvForAgent(agent2Dir);

    expect(process.env[EXPLICIT_KEY]).toBe('from_dotenv');
  });

  it('skips the load when the disable flag is 1', async () => {
    process.env[DISABLE_FLAG] = '1';
    await writeEnvFile(agentDir, `${DOTENV_KEY}=from_dotenv\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);

    expect(process.env[DOTENV_KEY]).toBeUndefined();
  });

  it('skips the load when the disable flag is TRUE in any case', async () => {
    process.env[DISABLE_FLAG] = 'TRUE';
    await writeEnvFile(agentDir, `${DOTENV_KEY}=from_dotenv\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);

    expect(process.env[DOTENV_KEY]).toBeUndefined();
  });

  it.each(['0', 'false', ''])(
    'loads the .env when the disable flag is %j',
    async (flag) => {
      process.env[DISABLE_FLAG] = flag;
      await writeEnvFile(agentDir, `${DOTENV_KEY}=from_dotenv\n`);
      const {loadDotenvForAgent} = await importEnvs();

      loadDotenvForAgent(agentDir);

      expect(process.env[DOTENV_KEY]).toBe('from_dotenv');
    },
  );

  it('walks up to a .env in a parent folder', async () => {
    await writeEnvFile(agentsDir, `${DOTENV_KEY}=from_parent\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);

    expect(process.env[DOTENV_KEY]).toBe('from_parent');
  });

  it('prefers the nearest .env over one further up', async () => {
    await writeEnvFile(agentsDir, `${DOTENV_KEY}=from_parent\n`);
    await writeEnvFile(agentDir, `${DOTENV_KEY}=from_agent\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);

    expect(process.env[DOTENV_KEY]).toBe('from_agent');
  });

  it('returns quietly when no .env exists above the agent', async () => {
    const {loadDotenvForAgent} = await importEnvs();

    expect(() => loadDotenvForAgent(agentDir)).not.toThrow();
    expect(process.env[DOTENV_KEY]).toBeUndefined();
  });

  it('walks up when the agent folder does not exist', async () => {
    await writeEnvFile(agentsDir, `${DOTENV_KEY}=from_parent\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(path.join(agentsDir, 'does-not-exist'));

    expect(process.env[DOTENV_KEY]).toBe('from_parent');
  });

  it('ignores a folder named .env and keeps walking up', async () => {
    await fs.mkdir(path.join(agentDir, '.env'));
    await writeEnvFile(agentsDir, `${DOTENV_KEY}=from_parent\n`);
    const {loadDotenvForAgent} = await importEnvs();

    loadDotenvForAgent(agentDir);

    expect(process.env[DOTENV_KEY]).toBe('from_parent');
  });
});
