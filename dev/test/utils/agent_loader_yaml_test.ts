/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isLlmAgent, isSequentialAgent} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, describe, expect, it, vi} from 'vitest';

import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';

const ROOT_AGENT_YAML = `
agent_class: SequentialAgent
name: code_pipeline
description: Writes code, then reviews it.
sub_agents:
  - config_path: sub/writer.yaml
`;

const WRITER_YAML = `
name: writer
model: gemini-2.5-flash
instruction: Write the code.
`;

/** Loader options that import an entry point as written, with no esbuild pass. */
const UNCOMPILED = {compile: false, bundle: false};

/** How long a watcher-driven reload may take before the test fails. */
const WATCH_TIMEOUT_MS = 10000;

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, {recursive: true, force: true})),
  );
});

/**
 * Writes `files` (relative path -> contents) into a fresh agents directory and
 * returns it.
 *
 * The repository's node_modules is linked next to the agents directory rather
 * than inside it, so a fixture entry point can import `@google/adk` while the
 * loader's recursive watcher still only sees the fixture files.
 */
async function writeAgentsDir(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-yaml-agents-'));
  tempDirs.push(root);
  await fs.symlink(
    path.resolve('node_modules'),
    path.join(root, 'node_modules'),
    'dir',
  );

  const dir = path.join(root, 'agents');
  await fs.mkdir(dir);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, contents);
  }
  return dir;
}

/** A JavaScript entry point exporting an agent called `agentName`. */
function jsEntryPoint(agentName: string): string {
  return `
import {LlmAgent} from '@google/adk';
export const rootAgent = new LlmAgent({name: '${agentName}'});
`;
}

/** Waits for `loader` to serve the agent directory as an agent named `name`. */
async function waitForAgentNamed(
  loader: AgentLoader,
  agentDir: string,
  name: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const agentFile = await loader.getAgentFile(agentDir);
      expect((await agentFile.loadAgent()).name).toBe(name);
    },
    {timeout: WATCH_TIMEOUT_MS, interval: 50},
  );
}

describe('AgentFile with a declarative agent config', () => {
  it('builds the agent tree the config describes', async () => {
    const dir = await writeAgentsDir({
      'root_agent.yaml': ROOT_AGENT_YAML,
      'sub/writer.yaml': WRITER_YAML,
    });

    const agentFile = new AgentFile(path.join(dir, 'root_agent.yaml'));
    const agent = await agentFile.loadAgent();

    expect(isSequentialAgent(agent)).toBe(true);
    expect(agent.name).toBe('code_pipeline');
    expect(agent.subAgents.map((sub) => sub.name)).toEqual(['writer']);
    expect(isLlmAgent(agent.subAgents[0])).toBe(true);
  });

  it('keeps the config path, because it compiles no artifact', async () => {
    const dir = await writeAgentsDir({'root_agent.yml': WRITER_YAML});
    const configPath = path.join(dir, 'root_agent.yml');

    const agentFile = new AgentFile(configPath);
    await agentFile.loadAgent();

    // getFilePath() reports the compiled artifact whenever there is one, so
    // the original path means esbuild never ran.
    expect(agentFile.getFilePath()).toBe(configPath);
  });

  it('survives disposal, because it holds no compiled artifact', async () => {
    const dir = await writeAgentsDir({'root_agent.yaml': WRITER_YAML});
    const configPath = path.join(dir, 'root_agent.yaml');

    const agentFile = new AgentFile(configPath);
    await agentFile.loadAgent();
    await agentFile.dispose();

    expect(agentFile.getFilePath()).toBe(configPath);
    await expect(fs.stat(configPath)).resolves.toBeDefined();
  });

  it('wraps the config agent in an app named after it', async () => {
    const dir = await writeAgentsDir({'root_agent.yaml': WRITER_YAML});

    const agentFile = new AgentFile(path.join(dir, 'root_agent.yaml'));
    const app = await agentFile.loadApp();

    expect(app.name).toBe('writer');
    expect(app.rootAgent.name).toBe('writer');
  });

  it('reports the file and the field of an invalid config', async () => {
    const dir = await writeAgentsDir({
      'root_agent.yaml': 'name: writer\ninstuction: Write the code.\n',
    });
    const configPath = path.join(dir, 'root_agent.yaml');

    await expect(new AgentFile(configPath).loadAgent()).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(await fs.realpath(configPath)),
      }),
    );
  });

  it('reports a missing config file', async () => {
    const dir = await writeAgentsDir({});

    await expect(
      new AgentFile(path.join(dir, 'root_agent.yaml')).loadAgent(),
    ).rejects.toThrowError(/does not exists/);
  });
});

describe('AgentLoader with a declarative agent config', () => {
  it('lists a directory whose only entry point is root_agent.yaml', async () => {
    const dir = await writeAgentsDir({
      'greeter/root_agent.yaml': ROOT_AGENT_YAML,
      'greeter/sub/writer.yaml': WRITER_YAML,
    });
    const loader = new AgentLoader(dir);

    expect(await loader.listAgents()).toEqual(['greeter']);

    const agent = await (await loader.getAgentFile('greeter')).loadAgent();
    expect(agent.name).toBe('code_pipeline');
  });

  it('accepts the .yml spelling', async () => {
    const dir = await writeAgentsDir({'greeter/root_agent.yml': WRITER_YAML});

    expect(await new AgentLoader(dir).listAgents()).toEqual(['greeter']);
  });

  it('prefers a JavaScript entry point over root_agent.yaml', async () => {
    const dir = await writeAgentsDir({
      'greeter/agent.mjs': jsEntryPoint('from_js_entry_point'),
      'greeter/root_agent.yaml': WRITER_YAML,
    });
    const loader = new AgentLoader(dir, UNCOMPILED);

    const agent = await (await loader.getAgentFile('greeter')).loadAgent();

    expect(agent.name).toBe('from_js_entry_point');
  });

  it('ignores a directory that holds neither an entry point nor a config', async () => {
    const dir = await writeAgentsDir({'notes/README.md': '# nothing here\n'});

    expect(await new AgentLoader(dir).listAgents()).toEqual([]);
  });

  it('names the broken file when a config in the directory is invalid', async () => {
    const dir = await writeAgentsDir({
      'greeter/root_agent.yaml': 'name: writer\ninstuction: Write it.\n',
    });

    await expect(new AgentLoader(dir).listAgents()).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('root_agent.yaml'),
      }),
    );
  });

  it('reloads a config the watcher sees change', async () => {
    const dir = await writeAgentsDir({'greeter/root_agent.yaml': WRITER_YAML});
    const loader = new AgentLoader(dir, undefined, true);
    await loader.listAgents();

    await fs.writeFile(
      path.join(dir, 'greeter', 'root_agent.yaml'),
      WRITER_YAML.replace('name: writer', 'name: rewriter'),
    );

    try {
      await waitForAgentNamed(loader, 'greeter', 'rewriter');
    } finally {
      await loader.disposeAll();
    }
  });
});
