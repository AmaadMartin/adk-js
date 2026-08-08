/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
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

import {App, isApp} from '@google/adk';
import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';
import * as fileUtils from '../../src/utils/file_utils.js';

vi.mock('../../src/utils/file_utils.js', () => ({
  createTempDir: vi.fn(),
  isFile: vi.fn(),
  isFileExists: vi.fn(),
  isFolderExists: vi.fn(),
  removeFolder: vi.fn(),
  tryToFindFileRecursively: vi.fn(),
}));

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>();
  return {
    ...actual,
    default: {
      ...(actual as unknown as {default: {build: Mock}}).default,
      build: vi.fn(),
    },
  };
});

const agent1JsContent = `
import {BaseAgent} from '@google/adk';

class FakeAgent1 extends BaseAgent {
  constructor(name) {
    super({ name });
  }
}
exports.rootAgent = new FakeAgent1('agent1');`;

const agent2TsContent = `
import {BaseAgent} from '@google/adk';

class FakeAgent2 extends BaseAgent {
  constructor(public name: string) {
    super({ name });
  }
}
export const rootAgent = new FakeAgent2('agent2');`;

const agent2CjsContentMocked = `
"use strict";
const {BaseAgent} = require('@google/adk');

class FakeAgent2 extends BaseAgent {
    constructor(name) {
      super({ name });
    }
}
exports.rootAgent = new FakeAgent2('agent2');
`;

const agent3JsContent = `
const {BaseAgent} = require('@google/adk');

class FakeAgent3 extends BaseAgent {
  constructor(name) {
    super({ name });
  }
}
exports.rootAgent = new FakeAgent3('agent3');`;

const agentDefaultExportContent = `;
import {BaseAgent} from '@google/adk';

class FakeAgentDefault extends BaseAgent {
  constructor(name) {
    super({name});
  }
}

export default new FakeAgentDefault('agentDefault');
`;

const agentMultipleExportsContent = `;
import {BaseAgent} from '@google/adk';

class FakeAgent extends BaseAgent {
  constructor(name) {
    super({name});
  }
}

export const agent1 = new FakeAgent('agent1');
export const agent2 = new FakeAgent('agent2');
`;

const appJsContent = `
const {App, BaseAgent} = require('@google/adk');

class FakeAgentForApp extends BaseAgent {
  constructor(name) {
    super({ name });
  }
}
const agent = new FakeAgentForApp('agent_for_app');
exports.app = new App({ name: 'test_app', rootAgent: agent });
`;

const appDefaultExportContent = `
import {App, BaseAgent} from '@google/adk';

class FakeAgentForApp extends BaseAgent {
  constructor(name) {
    super({ name });
  }
}
const agent = new FakeAgentForApp('agent_for_app_default');
export default new App({ name: 'test_app_default', rootAgent: agent });
`;

const agentCjsContent = `
const {BaseAgent} = require('@google/adk');

class FakeCjsAgent extends BaseAgent {
  constructor(name) {
    super({ name });
  }
}
exports.rootAgent = new FakeCjsAgent('agent_cjs');
`;

const agentEsmContent = `
import {BaseAgent} from '@google/adk';

class FakeEsmAgent extends BaseAgent {
  constructor(name) {
    super({ name });
  }
}
export const rootAgent = new FakeEsmAgent('agent_esm');
`;

/** The batched `esbuild.build` option shape the agent loader passes. */
interface BatchBuildOptions {
  entryPoints: Array<{in: string; out: string}>;
  outdir: string;
  outExtension: {'.js': string};
  format: string;
}

/** A temp directory handed out by the mocked `createTempDir`. */
interface TempDirRecord {
  prefix: string;
  dir: string;
}

describe('AgentLoader', () => {
  let tempAgentsDir: string;
  let tempLoaderDir: string;
  let createdTempDirs: TempDirRecord[];

  /** Returns the options of the given mocked `esbuild.build` call. */
  function buildOptions(callIndex: number): BatchBuildOptions {
    return (esbuild.build as Mock).mock.calls[callIndex][0];
  }

  /** Returns the temp directories created under the given prefix. */
  function tempDirsWithPrefix(prefix: string): string[] {
    return createdTempDirs
      .filter((record) => record.prefix === prefix)
      .map((record) => record.dir);
  }

  /**
   * Makes `esbuild.build` write the given content for every entry point of the
   * batch, at the path the loader expects to rename from.
   */
  function mockEsbuildBuild(
    contentFor: (entryPath: string) => string | Promise<string>,
  ) {
    (esbuild.build as Mock).mockImplementation(
      async (options: BatchBuildOptions) => {
        const ext = options.outExtension['.js'];
        await Promise.all(
          options.entryPoints.map(async (entry) =>
            fs.writeFile(
              path.join(options.outdir, entry.out + ext),
              await contentFor(entry.in),
            ),
          ),
        );
      },
    );
  }

  beforeAll(async () => {
    tempAgentsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'agent-loader-test'),
    );
    tempLoaderDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'agent-loader-output-test'),
    );
    await initNpmProject();
  }, 60000);

  afterAll(async () => {
    await fs.rm(tempAgentsDir, {recursive: true, force: true});
    await fs.rm(tempLoaderDir, {recursive: true, force: true});
  });

  beforeEach(async () => {
    createdTempDirs = [];
    (fileUtils.createTempDir as Mock).mockImplementation(
      async (prefix: string) => {
        await fs.mkdir(tempLoaderDir, {recursive: true});
        const dir = await fs.mkdtemp(path.join(tempLoaderDir, 'agent-'));
        createdTempDirs.push({prefix, dir});
        return dir;
      },
    );
    (fileUtils.isFile as Mock).mockImplementation(async (filePath) => {
      try {
        const stat = await fs.stat(filePath as string);
        return stat.isFile();
      } catch {
        return false;
      }
    });
    (fileUtils.isFileExists as Mock).mockImplementation(() => true);
    (fileUtils.isFolderExists as Mock).mockImplementation(
      async (folderPath) => {
        try {
          const stat = await fs.stat(folderPath as string);
          return stat.isDirectory();
        } catch {
          return false;
        }
      },
    );
    (fileUtils.removeFolder as Mock).mockImplementation((folderPath) =>
      fs.rm(folderPath as string, {recursive: true, force: true}),
    );
    (fileUtils.tryToFindFileRecursively as Mock).mockImplementation(
      async (_sourceFolder, fileName) => path.join(tempAgentsDir, fileName),
    );
  });

  afterEach(async () => {
    try {
      const files = await fs.readdir(tempAgentsDir);
      for (const file of files) {
        if (file !== 'package.json' && file !== 'node_modules') {
          await fs.rm(path.join(tempAgentsDir, file), {
            recursive: true,
            force: true,
          });
        }
      }
    } catch {
      // ignore
    }

    try {
      const files = await fs.readdir(tempLoaderDir);
      for (const file of files) {
        await fs.rm(path.join(tempLoaderDir, file), {
          recursive: true,
          force: true,
        });
      }
    } catch {
      // ignore
    }

    vi.clearAllMocks();
  });

  async function initNpmProject() {
    await fs.writeFile(
      path.join(tempAgentsDir, 'package.json'),
      JSON.stringify({
        name: 'test-agents',
        version: '1.0.0',
      }),
    );

    const adkPath = path.resolve(
      path.dirname(require.resolve('@google/adk')),
      '..',
      '..',
    );
    const nodeModulesDir = path.join(tempAgentsDir, 'node_modules');
    const googleDir = path.join(nodeModulesDir, '@google');
    await fs.mkdir(googleDir, {recursive: true});
    await fs.symlink(adkPath, path.join(googleDir, 'adk'), 'dir');
  }

  describe('AgentFile', () => {
    it('loads .js agent file', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockEsbuildBuild(() => agent1JsContent);

      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent1');
      const compiledAgentPath = agentFile.getFilePath();
      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('loads .ts agent file and compiles it', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      mockEsbuildBuild(() => agent2CjsContentMocked);

      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent2');
      expect((esbuild.build as Mock).mock.calls[0][0]).toMatchObject({
        entryPoints: [{in: agentPath, out: expect.any(String)}],
        outdir: expect.any(String),
        outExtension: {'.js': '.cjs'},
        target: 'node16',
        platform: 'node',
        format: 'cjs',
        packages: 'bundle',
        bundle: true,
        minify: true,
        external: expect.arrayContaining(['onnxruntime-node']),
      });

      const compiledAgentPath = agentFile.getFilePath();
      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('compiles a lone entrypoint as a batch of one', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockEsbuildBuild(() => agent1JsContent);

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();

      expect(esbuild.build).toHaveBeenCalledTimes(1);
      expect(buildOptions(0).entryPoints).toHaveLength(1);
      await agentFile.dispose();
    });

    it('compiles into a private temp dir without allowing overwrite', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockEsbuildBuild(() => agent1JsContent);

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();

      expect(fileUtils.createTempDir).toHaveBeenCalledWith('adk_agent_loader');
      expect(
        (esbuild.build as Mock).mock.calls[0][0].allowOverwrite,
      ).toBeUndefined();

      await agentFile.dispose();
    });

    it('throws if rootAgent is not found', async () => {
      const agentPath = path.join(tempAgentsDir, 'bad_agent.js');
      await fs.writeFile(agentPath, 'exports.someOther = 1;');

      mockEsbuildBuild(() => 'exports.someOther = 1;');

      const agentFile = new AgentFile(agentPath);
      const loadError = await agentFile.load().catch((e: unknown) => e);
      const compiledAgentPath = path.join(
        tempDirsWithPrefix('adk_agent_loader')[0],
        'bad_agent.cjs',
      );

      expect(loadError).toBeInstanceOf(Error);
      expect(loadError).toHaveProperty(
        'message',
        `Failed to load agent ${
          compiledAgentPath
        }: No @google/adk BaseAgent class instance found. Please check that file is not empty and it has export of @google/adk BaseAgent class (e.g. LlmAgent) instance.`,
      );
      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('throws when getting file path if agent is not loaded', () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      const agentFile = new AgentFile(agentPath);
      expect(() => agentFile.getFilePath()).toThrow('Agent is not loaded yet');
    });

    it('throws when getting file path if agent is disposed', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockEsbuildBuild(() => agent1JsContent);

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();
      await agentFile.dispose();
      expect(() => agentFile.getFilePath()).toThrow(
        'Agent is disposed and can not be used',
      );
    });

    it('returns cleanup file path if compiled', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      mockEsbuildBuild(() => agent2CjsContentMocked);

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();
      expect(agentFile.getFilePath()).toEqual(
        path.join(tempDirsWithPrefix('adk_agent_loader')[0], 'agent2.cjs'),
      );
      await agentFile.dispose();
    });

    it('returns original file path if not compiled', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const agentFile = new AgentFile(agentPath, {
        compile: false,
        bundle: false,
      });
      await agentFile.load();
      expect(agentFile.getFilePath()).toEqual(agentPath);
      await agentFile.dispose();
    });

    it('loads agent with default export', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent_default.js');
      await fs.writeFile(agentPath, agentDefaultExportContent);

      mockEsbuildBuild(() => agentDefaultExportContent);

      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agentDefault');
      const compiledAgentPath = agentFile.getFilePath();
      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('loads an app file and returns the app via load()', async () => {
      const appPath = path.join(tempAgentsDir, 'app1.js');
      await fs.writeFile(appPath, appJsContent);

      mockEsbuildBuild(() => appJsContent);

      const agentFile = new AgentFile(appPath);
      const loaded = await agentFile.load();

      expect(isApp(loaded)).toBe(true);
      expect((loaded as App).name).toBe('test_app');
      expect((loaded as App).rootAgent.name).toBe('agent_for_app');
      await agentFile.dispose();
    });

    it('loads an app via loadApp() and rootAgent via loadAgent()', async () => {
      const appPath = path.join(tempAgentsDir, 'app_default.js');
      await fs.writeFile(appPath, appDefaultExportContent);

      mockEsbuildBuild(() => appDefaultExportContent);

      const agentFile = new AgentFile(appPath);
      const app = await agentFile.loadApp();
      const agent = await agentFile.loadAgent();

      expect(app.name).toBe('test_app_default');
      expect(agent.name).toBe('agent_for_app_default');
      await agentFile.dispose();
    });

    it('synthesizes an App when loadApp() is called on a BaseAgent file', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockEsbuildBuild(() => agent1JsContent);

      const agentFile = new AgentFile(agentPath);
      const app = await agentFile.loadApp();

      expect(isApp(app)).toBe(true);
      expect(app.name).toBe('agent1');
      expect(app.rootAgent.name).toBe('agent1');
      await agentFile.dispose();
    });

    it('loads first agent if multiple agents exported', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent_multiple.js');
      await fs.writeFile(agentPath, agentMultipleExportsContent);

      mockEsbuildBuild(() => agentMultipleExportsContent);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent1');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Multiple agents found'),
      );
      await agentFile.dispose();
      consoleSpy.mockRestore();
    });

    it('caches loaded agent instance', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockEsbuildBuild(() => agent1JsContent);

      const agentFile = new AgentFile(agentPath);
      const agent1 = await agentFile.load();
      const agent2 = await agentFile.load();

      expect(agent1).toBe(agent2);
      await agentFile.dispose();
    });

    it('throws specific error if file does not exist', async () => {
      const agentPath = path.join(tempAgentsDir, 'non_existent.js');
      const agentFile = new AgentFile(agentPath);

      await expect(agentFile.load()).rejects.toThrow(
        `Agent file ${agentPath} does not exists`,
      );
    });
  });

  describe('AgentLoader', () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(tempAgentsDir, 'agent1.js'),
        agent1JsContent,
      );

      const agent2Path = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agent2Path, agent2TsContent);
      await fs.mkdir(path.join(tempAgentsDir, 'agent3'));
      await fs.writeFile(
        path.join(tempAgentsDir, 'agent3', 'agent.js'),
        agent3JsContent,
      );

      mockEsbuildBuild((entryPath) => {
        if (entryPath.includes('agent1.js')) {
          return agent1JsContent;
        }
        if (entryPath.includes('agent2.ts')) {
          return agent2CjsContentMocked;
        }
        if (entryPath.includes('agent3')) {
          return agent3JsContent;
        }
        return fs.readFile(entryPath, 'utf8');
      });
    });

    it('lists all agents', async () => {
      const agentLoader = new AgentLoader(tempAgentsDir);
      const agents = await agentLoader.listAgents();
      expect(agents).toEqual(['agent1', 'agent2', 'agent3']);
      await agentLoader.disposeAll();
    });

    it('gets agent file', async () => {
      const agentLoader = new AgentLoader(tempAgentsDir);
      const agentFile = await agentLoader.getAgentFile('agent1');
      const agent = await agentFile.load();
      expect(agent.name).toEqual('agent1');
      await agentLoader.disposeAll();
    });

    it('disposes all agent files', async () => {
      const agentLoader = new AgentLoader(tempAgentsDir);
      await agentLoader.listAgents();

      const agent2File = await agentLoader.getAgentFile('agent2');
      await agent2File.load();
      const compiledAgent2Path = agent2File.getFilePath();
      await fs.access(compiledAgent2Path);

      await agentLoader.disposeAll();
      await expect(fs.access(compiledAgent2Path)).rejects.toThrow();
    });

    it('can load agent when agentDir is the filepath', async () => {
      (fileUtils.isFile as Mock).mockReturnValue(true);
      const loader = new AgentLoader(path.join(tempAgentsDir, 'agent1.js'));
      const agents = await loader.listAgents();
      expect(agents).toEqual(['agent1']);
      const agentFile = await loader.getAgentFile('agent1');
      const agent = await agentFile.load();
      expect(agent.name).toBe('agent1');
      await loader.disposeAll();
    });

    it('does not preload agents again if already preloaded', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      await loader.preloadAgents();

      const buildsAfterFirstPreload = (esbuild.build as Mock).mock.calls.length;
      await loader.preloadAgents();

      expect((esbuild.build as Mock).mock.calls).toHaveLength(
        buildsAfterFirstPreload,
      );
      await loader.disposeAll();
    });

    it('compiles every discovered entrypoint in one build', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const agents = await loader.listAgents();

      expect(agents).toEqual(['agent1', 'agent2', 'agent3']);
      expect(esbuild.build).toHaveBeenCalledTimes(1);
      expect(
        buildOptions(0)
          .entryPoints.map((entry) => entry.in)
          .sort(),
      ).toEqual([
        path.join(tempAgentsDir, 'agent1.js'),
        path.join(tempAgentsDir, 'agent2.ts'),
        path.join(tempAgentsDir, 'agent3', 'agent.js'),
      ]);

      await loader.disposeAll();
    });

    it('gives every entrypoint its own output file and directory', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      await loader.listAgents();

      const compiledPaths = await Promise.all(
        ['agent1', 'agent2', 'agent3'].map(async (name) =>
          (await loader.getAgentFile(name)).getFilePath(),
        ),
      );

      expect(new Set(compiledPaths).size).toBe(3);
      expect(new Set(compiledPaths.map((p) => path.dirname(p))).size).toBe(3);
      await expect(fs.readFile(compiledPaths[0], 'utf8')).resolves.toBe(
        agent1JsContent,
      );
      await expect(fs.readFile(compiledPaths[1], 'utf8')).resolves.toBe(
        agent2CjsContentMocked,
      );
      await expect(fs.readFile(compiledPaths[2], 'utf8')).resolves.toBe(
        agent3JsContent,
      );

      await loader.disposeAll();
    });

    it('builds cjs and esm entrypoints in separate builds', async () => {
      const mixedDir = await fs.mkdtemp(path.join(tempAgentsDir, 'mixed-'));
      await fs.writeFile(path.join(mixedDir, 'first.cjs'), agentCjsContent);
      await fs.writeFile(path.join(mixedDir, 'second.mjs'), agentEsmContent);
      mockEsbuildBuild((entryPath) => fs.readFile(entryPath, 'utf8'));

      const loader = new AgentLoader(mixedDir);
      const agents = await loader.listAgents();

      expect(agents).toEqual(['first', 'second']);
      expect(esbuild.build).toHaveBeenCalledTimes(2);
      expect([buildOptions(0), buildOptions(1)]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            format: 'cjs',
            outExtension: {'.js': '.cjs'},
          }),
          expect.objectContaining({
            format: 'esm',
            outExtension: {'.js': '.mjs'},
          }),
        ]),
      );

      await loader.disposeAll();
    });

    it('removes every temp directory when the build fails', async () => {
      (esbuild.build as Mock).mockRejectedValue(new Error('build failed'));

      const loader = new AgentLoader(tempAgentsDir);

      await expect(loader.listAgents()).rejects.toThrow('build failed');
      expect(createdTempDirs.length).toBeGreaterThan(0);
      for (const {dir} of createdTempDirs) {
        await expect(fs.access(dir)).rejects.toThrow();
      }
    });

    it('skips the build when compile and bundle are both off', async () => {
      const loader = new AgentLoader(tempAgentsDir, {
        compile: false,
        bundle: false,
      });
      const agents = await loader.listAgents();

      expect(agents).toEqual(['agent1', 'agent2', 'agent3']);
      expect(esbuild.build).not.toHaveBeenCalled();
      expect(createdTempDirs).toEqual([]);
      await loader.disposeAll();
    });

    it('creates no build for a directory with no entrypoint', async () => {
      const emptyDir = await fs.mkdtemp(path.join(tempAgentsDir, 'empty-'));

      const loader = new AgentLoader(emptyDir);
      const agents = await loader.listAgents();

      expect(agents).toEqual([]);
      expect(esbuild.build).not.toHaveBeenCalled();
      expect(createdTempDirs).toEqual([]);
      await loader.disposeAll();
    });

    it('propagates an import error that is not an agent loading error', async () => {
      const boomDir = await fs.mkdtemp(path.join(tempAgentsDir, 'boom-'));
      await fs.writeFile(
        path.join(boomDir, 'boom.js'),
        `throw new Error('boom');`,
      );

      const loader = new AgentLoader(boomDir);

      await expect(loader.listAgents()).rejects.toThrow('boom');
    });

    it('removes the batch scratch directory after a successful preload', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      await loader.listAgents();

      const scratchDirs = tempDirsWithPrefix('adk_agent_build');
      expect(scratchDirs).toHaveLength(1);
      await expect(fs.access(scratchDirs[0])).rejects.toThrow();

      const agentDirs = tempDirsWithPrefix('adk_agent_loader');
      expect(agentDirs).toHaveLength(3);
      for (const dir of agentDirs) {
        await fs.access(dir);
      }

      await loader.disposeAll();
    });

    it('handles AgentFileLoadingError in directory loading', async () => {
      await fs.mkdir(path.join(tempAgentsDir, 'bad_agent_dir'));
      await fs.writeFile(
        path.join(tempAgentsDir, 'bad_agent_dir', 'agent.js'),
        'exports.foo = "bar";',
      );

      const loader = new AgentLoader(tempAgentsDir);
      const agents = await loader.listAgents();

      expect(agents).not.toContain('bad_agent_dir');
      await loader.disposeAll();
    });

    it('discovers app entrypoint files (e.g. app.js) in directories and lists them via listApps() / getAppFile()', async () => {
      const appDir = path.join(tempAgentsDir, 'my_service');
      await fs.mkdir(appDir, {recursive: true});
      await fs.writeFile(path.join(appDir, 'app.js'), appJsContent);

      const loader = new AgentLoader(tempAgentsDir);
      const apps = await loader.listApps();

      expect(apps).toContain('my_service');

      const appFile = await loader.getAppFile('my_service');
      const loaded = await appFile.load();

      expect(isApp(loaded)).toBe(true);
      expect((loaded as App).name).toBe('test_app');

      await loader.disposeAll();
    });

    it('resets preload cache when invalidateAll is called (simulates file-change reload)', async () => {
      const loader = new AgentLoader(tempAgentsDir);

      // Initial load should populate the cache and mark as preloaded
      await loader.listAgents();
      expect(
        (loader as unknown as {agentsAlreadyPreloaded: boolean})
          .agentsAlreadyPreloaded,
      ).toBe(true);

      // Simulate what the fs.watch callback does when a file changes
      (loader as unknown as {invalidateAll: () => void}).invalidateAll();

      // After invalidation the preloaded flag is reset so that the next
      // request triggers a full re-scan from disk
      expect(
        (loader as unknown as {agentsAlreadyPreloaded: boolean})
          .agentsAlreadyPreloaded,
      ).toBe(false);

      await loader.disposeAll();
    });
  });
});
