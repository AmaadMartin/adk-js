/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  Mock,
  vi,
} from 'vitest';

import {copyAgentFiles} from '../../src/cli/deploy/deploy_utils.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

// Only the bundler is faked, and only so the suite does not pay a full
// @google/adk bundle per agent. The loader, the compiled artifact, its temp
// directory and the copy itself are all real.
vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<{default: typeof import('esbuild')}>();
  return {...actual, default: {...actual.default, build: vi.fn()}};
});

const require = createRequire(import.meta.url);

const AGENT_CONTENT = `
const {BaseAgent} = require('@google/adk');

class FakeAgent extends BaseAgent {
  constructor(name) {
    super({name});
  }
}
exports.rootAgent = new FakeAgent('agent1');
`;

async function createAgentsProject(...files: Array<[string, string]>) {
  const agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-utils-'));
  await fs.writeFile(
    path.join(agentsDir, 'package.json'),
    JSON.stringify({name: 'test-agents', version: '1.0.0'}),
  );

  const adkPath = path.resolve(
    path.dirname(require.resolve('@google/adk')),
    '..',
    '..',
  );
  const googleDir = path.join(agentsDir, 'node_modules', '@google');
  await fs.mkdir(googleDir, {recursive: true});
  await fs.symlink(adkPath, path.join(googleDir, 'adk'), 'dir');

  for (const [fileName, content] of files) {
    await fs.writeFile(path.join(agentsDir, fileName), content);
  }

  return agentsDir;
}

describe('copyAgentFiles', () => {
  let agentsDir: string;
  let targetDir: string;
  let loader: AgentLoader;

  beforeAll(async () => {
    agentsDir = await createAgentsProject(
      ['agent1.js', AGENT_CONTENT],
      ['not_an_agent.js', 'exports.foo = "bar";'],
    );
  });

  afterAll(async () => {
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  beforeEach(async () => {
    (esbuild.build as Mock).mockImplementation(
      async (options: {entryPoints: string[]; outfile: string}) => {
        await fs.copyFile(options.entryPoints[0], options.outfile);
      },
    );
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-utils-out-'));
    loader = new AgentLoader(agentsDir);
  });

  afterEach(async () => {
    await loader.disposeAll();
    await fs.rm(targetDir, {recursive: true, force: true});
    vi.clearAllMocks();
  });

  it('copies the compiled bundle rather than the agent source', async () => {
    await copyAgentFiles(loader, targetDir);

    const agentFile = await loader.getAgentFile('agent1');
    const compiledPath = agentFile.getFilePath();

    expect(compiledPath).not.toBe(path.join(agentsDir, 'agent1.js'));
    expect(await fs.readFile(path.join(targetDir, 'agent1.cjs'), 'utf8')).toBe(
      await fs.readFile(compiledPath, 'utf8'),
    );
  });

  it('skips a candidate that is not an agent', async () => {
    await copyAgentFiles(loader, targetDir);

    expect(await fs.readdir(targetDir)).toEqual(['agent1.cjs']);
  });

  it('rethrows a load failure that is not an agent-loading error', async () => {
    const explodingDir = await createAgentsProject([
      'exploding_agent.js',
      'throw new Error("boom");',
    ]);
    const explodingLoader = new AgentLoader(explodingDir);

    try {
      await expect(copyAgentFiles(explodingLoader, targetDir)).rejects.toThrow(
        'boom',
      );
      expect(await fs.readdir(targetDir)).toEqual([]);
    } finally {
      await explodingLoader.disposeAll();
      await fs.rm(explodingDir, {recursive: true, force: true});
    }
  });
});
