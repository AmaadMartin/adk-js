/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {copyAgentFiles} from '../../src/cli/deploy/deploy_utils.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

/** Staging must work without esbuild, so the fixtures are already runnable. */
const UNCOMPILED = {compile: false, bundle: false};

function agentSource(agentName: string): string {
  return `
import {BaseAgent} from '@google/adk';

class FakeAgent extends BaseAgent {
  constructor(name) {
    super({name});
  }
}
export const rootAgent = new FakeAgent('${agentName}');
`;
}

/** Fails on import, so AgentLoader records a load failure and skips it. */
const BROKEN_AGENT_SOURCE = `throw new Error('fixture agent is broken');`;

async function writeAgentFile(
  dirPath: string,
  fileName: string,
  content: string,
): Promise<void> {
  await fs.mkdir(dirPath, {recursive: true});
  await fs.writeFile(path.join(dirPath, fileName), content);
}

async function readStaged(
  stagedDir: string,
  ...segments: string[]
): Promise<string> {
  return fs.readFile(path.join(stagedDir, ...segments), 'utf8');
}

describe('copyAgentFiles', () => {
  let sourceDir: string;
  let stagedDir: string;
  const loaders: AgentLoader[] = [];

  function newLoader(dirPath: string): AgentLoader {
    const loader = new AgentLoader(dirPath, UNCOMPILED);
    loaders.push(loader);
    return loader;
  }

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-utils-test'));
    sourceDir = path.join(root, 'agents');
    stagedDir = path.join(root, 'staged');
    await fs.mkdir(sourceDir, {recursive: true});
  });

  afterEach(async () => {
    await Promise.all(loaders.map((loader) => loader.disposeAll()));
    loaders.length = 0;
    await fs.rm(path.dirname(sourceDir), {recursive: true, force: true});
  });

  it('stages each directory-shaped agent under its own agent name', async () => {
    await writeAgentFile(
      path.join(sourceDir, 'weather'),
      'agent.js',
      agentSource('weather'),
    );
    await writeAgentFile(
      path.join(sourceDir, 'news'),
      'agent.js',
      agentSource('news'),
    );

    await copyAgentFiles(newLoader(sourceDir), stagedDir);

    expect(await readStaged(stagedDir, 'weather', 'agent.js')).toContain(
      "new FakeAgent('weather')",
    );
    expect(await readStaged(stagedDir, 'news', 'agent.js')).toContain(
      "new FakeAgent('news')",
    );
  });

  it('lets a second loader rediscover the staged tree under the original names', async () => {
    await writeAgentFile(
      path.join(sourceDir, 'weather'),
      'agent.js',
      agentSource('weather'),
    );
    await writeAgentFile(
      path.join(sourceDir, 'news'),
      'agent.js',
      agentSource('news'),
    );

    await copyAgentFiles(newLoader(sourceDir), stagedDir);

    expect(await newLoader(stagedDir).listAgents()).toEqual([
      'news',
      'weather',
    ]);
  });

  it('keeps the names of file-shaped agents', async () => {
    await writeAgentFile(sourceDir, 'foo.js', agentSource('foo'));
    await writeAgentFile(sourceDir, 'bar.js', agentSource('bar'));

    await copyAgentFiles(newLoader(sourceDir), stagedDir);

    expect(await readStaged(stagedDir, 'foo', 'agent.js')).toContain(
      "new FakeAgent('foo')",
    );
    expect(await readStaged(stagedDir, 'bar', 'agent.js')).toContain(
      "new FakeAgent('bar')",
    );
    expect(await newLoader(stagedDir).listAgents()).toEqual(['bar', 'foo']);
  });

  it('preserves the entry extension of a compiled artifact', async () => {
    await writeAgentFile(
      path.join(sourceDir, 'weather'),
      'agent.mjs',
      agentSource('weather'),
    );

    await copyAgentFiles(newLoader(sourceDir), stagedDir);

    expect(await fs.readdir(path.join(stagedDir, 'weather'))).toEqual([
      'agent.mjs',
    ]);
  });

  it('does not stage an agent that failed to load', async () => {
    await writeAgentFile(
      path.join(sourceDir, 'good'),
      'agent.js',
      agentSource('good'),
    );
    await writeAgentFile(
      path.join(sourceDir, 'broken'),
      'agent.js',
      BROKEN_AGENT_SOURCE,
    );

    await copyAgentFiles(newLoader(sourceDir), stagedDir);

    expect(await fs.readdir(stagedDir)).toEqual(['good']);
  });
});
