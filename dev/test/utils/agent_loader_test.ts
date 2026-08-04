/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {EventEmitter} from 'node:events';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
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
import {
  AgentFile,
  AgentLoader,
  replaceDirnamePlugin,
} from '../../src/utils/agent_loader.js';
import * as fileUtils from '../../src/utils/file_utils.js';

vi.mock('../../src/utils/file_utils.js', () => ({
  getTempDir: vi.fn(),
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

/**
 * Makes `fs.rmSync` fail on demand. `vi.spyOn(fs, 'rmSync')` cannot do this:
 * an ESM module namespace is not configurable, so the property cannot be
 * redefined. Every other `node:fs` export, and `rmSync` itself while the flag
 * is off, is the real implementation.
 */
const fsMockState = vi.hoisted(() => ({rmSyncFailure: '', rmSyncCalls: 0}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const rmSync: typeof actual.rmSync = (target, options) => {
    fsMockState.rmSyncCalls++;
    if (fsMockState.rmSyncFailure) {
      throw new Error(fsMockState.rmSyncFailure);
    }
    return actual.rmSync(target, options);
  };

  return {...actual, default: {...actual, rmSync}, rmSync};
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

type ProcessListener = (...args: unknown[]) => void;

/**
 * Process events the `AgentLoader` constructor registers a listener on.
 */
const PROCESS_CLEANUP_EVENTS = [
  'exit',
  'SIGINT',
  'SIGUSR1',
  'SIGUSR2',
  'uncaughtException',
];

/**
 * `process` seen as the plain emitter it is, so the event names above can be
 * iterated as strings instead of matching one typed overload each.
 */
const processEvents: EventEmitter = process;

/**
 * Preloads every agent and returns the compiled output directory of each one.
 */
async function preloadedOutputDirs(loader: AgentLoader): Promise<string[]> {
  const names = await loader.listAgents();

  return Promise.all(
    names.map(async (name) =>
      path.dirname((await loader.getAgentFile(name)).getFilePath()),
    ),
  );
}

describe('AgentLoader', () => {
  let tempAgentsDir: string;
  let tempLoaderDir: string;

  const compiledPath = (fileName: string) => path.join(tempLoaderDir, fileName);

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
    (fileUtils.getTempDir as Mock).mockImplementation(() => tempLoaderDir);
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

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent1');
      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('loads .ts agent file and compiles it', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      const compiledAgentPath = compiledPath('agent2.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent2CjsContentMocked);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent2');
      expect((esbuild.build as Mock).mock.calls[0][0]).toMatchObject({
        entryPoints: [agentPath],
        outfile: compiledAgentPath,
        target: 'node16',
        platform: 'node',
        format: 'cjs',
        packages: 'bundle',
        bundle: true,
        minify: true,
        allowOverwrite: true,
        external: expect.arrayContaining(['onnxruntime-node']),
      });

      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('throws if rootAgent is not found', async () => {
      const agentPath = path.join(tempAgentsDir, 'bad_agent.js');
      await fs.writeFile(agentPath, 'exports.someOther = 1;');

      const compiledAgentPath = compiledPath('bad_agent.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, 'exports.someOther = 1;');
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      await expect(agentFile.load()).rejects.toThrow(
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

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();
      await agentFile.dispose();
      expect(() => agentFile.getFilePath()).toThrow(
        'Agent is disposed and can not be used',
      );
    });

    it('returns cleanup file path if compiled', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      const compiledAgentPath = compiledPath('agent2.cjs');
      await fs.writeFile(agentPath, agent2TsContent);

      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent2CjsContentMocked);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();
      expect(agentFile.getFilePath()).toEqual(compiledAgentPath);
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

      const compiledAgentPath = compiledPath('agent_default.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agentDefaultExportContent);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agentDefault');
      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('loads an app file and returns the app via load()', async () => {
      const appPath = path.join(tempAgentsDir, 'app1.js');
      await fs.writeFile(appPath, appJsContent);

      const compiledAppPath = compiledPath('app1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAppPath, appJsContent);
        return Promise.resolve();
      });

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

      const compiledAppPath = compiledPath('app_default.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAppPath, appDefaultExportContent);
        return Promise.resolve();
      });

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

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
        return Promise.resolve();
      });

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

      const compiledAgentPath = compiledPath('agent_multiple.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agentMultipleExportsContent);
        return Promise.resolve();
      });

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

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
        return Promise.resolve();
      });

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

    it('removes the compiled output directory synchronously on disposeSync', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();
      expect(nodeFs.existsSync(tempLoaderDir)).toBe(true);

      agentFile.disposeSync();

      // No await between the call and the assertion: that ordering is what
      // pins the bug, since a process 'exit' listener gets nothing more.
      expect(nodeFs.existsSync(tempLoaderDir)).toBe(false);
      expect(() => agentFile.getFilePath()).toThrow(
        'Agent is disposed and can not be used',
      );
    });

    it('is a no-op when disposeSync runs twice', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();

      agentFile.disposeSync();
      const callsAfterFirst = fsMockState.rmSyncCalls;

      expect(() => agentFile.disposeSync()).not.toThrow();
      expect(fsMockState.rmSyncCalls).toBe(callsAfterFirst);
      expect(nodeFs.existsSync(tempLoaderDir)).toBe(false);
    });

    it('does not touch the filesystem when disposeSync runs after dispose', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();
      await agentFile.dispose();
      const callsAfterDispose = fsMockState.rmSyncCalls;

      agentFile.disposeSync();

      expect(fsMockState.rmSyncCalls).toBe(callsAfterDispose);
    });

    it('keeps an uncompiled agent file usable after disposeSync', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const agentFile = new AgentFile(agentPath, {
        compile: false,
        bundle: false,
      });
      await agentFile.load();

      agentFile.disposeSync();

      expect(agentFile.getFilePath()).toEqual(agentPath);
      expect(nodeFs.existsSync(agentPath)).toBe(true);
    });

    it('swallows a filesystem failure while removing the output directory', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();

      fsMockState.rmSyncFailure = 'EBUSY: resource busy or locked';
      try {
        expect(() => agentFile.disposeSync()).not.toThrow();
        expect(nodeFs.existsSync(tempLoaderDir)).toBe(true);
      } finally {
        fsMockState.rmSyncFailure = '';
      }

      expect(() => agentFile.getFilePath()).toThrow(
        'Agent is disposed and can not be used',
      );
    });

    it('does not follow the node_modules symlink when removing the output directory', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();
      expect(nodeFs.existsSync(path.join(tempLoaderDir, 'node_modules'))).toBe(
        true,
      );

      agentFile.disposeSync();

      expect(nodeFs.existsSync(tempLoaderDir)).toBe(false);
      expect(
        nodeFs.existsSync(
          path.join(tempAgentsDir, 'node_modules', '@google', 'adk'),
        ),
      ).toBe(true);
    });
  });

  describe('replaceDirnamePlugin', () => {
    it.each([
      {
        name: 'replaces __dirname with original directory',
        content: `const dir = __dirname;\nconsole.log(__dirname);`,
        expected: (filePath: string, fileDir: string) =>
          JSON.stringify(fileDir),
      },
      {
        name: 'replaces import.meta.url with file URL',
        content: 'const url = import.meta.url;',
        expected: (filePath: string) => pathToFileURL(filePath).href,
      },
      {
        name: 'replaces __filename with file path',
        content: 'const file = __filename;',
        expected: (filePath: string) => JSON.stringify(filePath),
      },
    ])('$name', async ({content, expected}) => {
      const filePath = path.join(tempAgentsDir, 'test_agent.ts');
      const fileDir = path.dirname(filePath);
      const plugin = replaceDirnamePlugin(filePath, fileDir);

      expect(plugin.name).toBe('replace-dirname');

      const mockBuild = {
        onLoad: vi.fn(),
      };

      plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

      expect(mockBuild.onLoad).toHaveBeenCalledWith(
        {filter: /.*/},
        expect.any(Function),
      );

      const onLoadCallback = mockBuild.onLoad.mock.calls[0][1];

      await fs.writeFile(filePath, content);

      const result = await onLoadCallback({path: filePath});

      expect(result.contents).toContain(expected(filePath, fileDir));
      expect(result.loader).toBe('js');
    });

    it('does not replace tokens in strings', async () => {
      const filePath = path.join(tempAgentsDir, 'test_agent.ts');
      const fileDir = path.dirname(filePath);
      const plugin = replaceDirnamePlugin(filePath, fileDir);

      const mockBuild = {
        onLoad: vi.fn(),
      };

      plugin.setup(mockBuild as unknown as esbuild.PluginBuild);
      const onLoadCallback = mockBuild.onLoad.mock.calls[0][1];

      await fs.writeFile(
        filePath,
        `const str = "__dirname";\nconst code = __dirname;`,
      );

      const result = await onLoadCallback({path: filePath});

      expect(result.contents).toContain('const str = "__dirname"');
      expect(result.contents).toContain(JSON.stringify(fileDir));
      expect(result.loader).toBe('js');
    });

    it('returns undefined for node_modules', async () => {
      const filePath = '/path/to/node_modules/some_pkg/index.js';
      const plugin = replaceDirnamePlugin(
        path.join(tempAgentsDir, 'test_agent.ts'),
        tempAgentsDir,
      );

      const mockBuild = {
        onLoad: vi.fn(),
      };

      plugin.setup(mockBuild as unknown as esbuild.PluginBuild);
      const onLoadCallback = mockBuild.onLoad.mock.calls[0][1];

      const result = await onLoadCallback({path: filePath});

      expect(result).toBeUndefined();
    });

    it('uses js loader for non-ts files', async () => {
      const filePath = path.join(tempAgentsDir, 'test_agent.js');
      const fileDir = path.dirname(filePath);
      const plugin = replaceDirnamePlugin(filePath, fileDir);

      const mockBuild = {
        onLoad: vi.fn(),
      };

      plugin.setup(mockBuild as unknown as esbuild.PluginBuild);
      const onLoadCallback = mockBuild.onLoad.mock.calls[0][1];

      // Write real file
      await fs.writeFile(filePath, 'const dir = __dirname;');

      const result = await onLoadCallback({path: filePath});

      expect(result).toMatchObject({
        loader: 'js',
      });
    });

    it('returns js loader for mts files', async () => {
      const filePath = path.join(tempAgentsDir, 'test_agent.mts');
      const fileDir = path.dirname(filePath);
      const plugin = replaceDirnamePlugin(filePath, fileDir);

      const mockBuild = {
        onLoad: vi.fn(),
      };

      plugin.setup(mockBuild as unknown as esbuild.PluginBuild);
      const onLoadCallback = mockBuild.onLoad.mock.calls[0][1];

      await fs.writeFile(filePath, 'const dir = __dirname;');

      const result = await onLoadCallback({path: filePath});

      expect(result).toMatchObject({
        loader: 'js',
      });
    });

    it('returns js loader for cts files', async () => {
      const filePath = path.join(tempAgentsDir, 'test_agent.cts');
      const fileDir = path.dirname(filePath);
      const plugin = replaceDirnamePlugin(filePath, fileDir);

      const mockBuild = {
        onLoad: vi.fn(),
      };

      plugin.setup(mockBuild as unknown as esbuild.PluginBuild);
      const onLoadCallback = mockBuild.onLoad.mock.calls[0][1];

      await fs.writeFile(filePath, 'const dir = __dirname;');

      const result = await onLoadCallback({path: filePath});

      expect(result).toMatchObject({
        loader: 'js',
      });
    });
  });

  describe('AgentLoader', () => {
    beforeEach(async () => {
      let loaderOutputDirIndex = 0;
      (fileUtils.getTempDir as Mock).mockImplementation(() =>
        path.join(
          tempLoaderDir,
          `agent-${Date.now()}-${Math.random().toString(36).slice(2)}-${loaderOutputDirIndex++}`,
        ),
      );

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

      (esbuild.build as Mock).mockImplementation(
        async (options: {entryPoints: string[]; outfile: string}) => {
          if (options.entryPoints[0].includes('agent1.js')) {
            await fs.writeFile(options.outfile, agent1JsContent);
          } else if (options.entryPoints[0].includes('agent2.ts')) {
            await fs.writeFile(options.outfile, agent2CjsContentMocked);
          } else if (options.entryPoints[0].includes('agent3')) {
            await fs.writeFile(options.outfile, agent3JsContent);
          } else {
            const content = await fs.readFile(options.entryPoints[0], 'utf8');
            await fs.writeFile(options.outfile, content);
          }

          return Promise.resolve();
        },
      );
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

      const spy = vi.spyOn(
        loader as unknown as {loadAgentFromFile: () => void},
        'loadAgentFromFile',
      );
      await loader.preloadAgents();

      expect(spy).not.toHaveBeenCalled();
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

    it('removes every preloaded output directory synchronously on disposeAllSync', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const outputDirs = await preloadedOutputDirs(loader);

      expect(outputDirs).toHaveLength(3);
      for (const outputDir of outputDirs) {
        expect(nodeFs.existsSync(outputDir)).toBe(true);
      }

      loader.disposeAllSync();

      for (const outputDir of outputDirs) {
        expect(nodeFs.existsSync(outputDir)).toBe(false);
      }
    });

    it('cleans up synchronously from the exit listener installed by the constructor', async () => {
      const listenersBefore = new Map(
        PROCESS_CLEANUP_EVENTS.map((event) => [
          event,
          processEvents.listeners(event),
        ]),
      );
      const loader = new AgentLoader(tempAgentsDir);

      try {
        const outputDirs = await preloadedOutputDirs(loader);
        expect(outputDirs).toHaveLength(3);

        // Invoke this loader's own listener rather than emitting 'exit', which
        // would also run the listeners every other loader in this file left
        // registered.
        const addedExitListeners = processEvents
          .listeners('exit')
          .filter(
            (listener) => !listenersBefore.get('exit')!.includes(listener),
          );
        expect(addedExitListeners).toHaveLength(1);

        (addedExitListeners[0] as () => void)();

        for (const outputDir of outputDirs) {
          expect(nodeFs.existsSync(outputDir)).toBe(false);
        }
      } finally {
        for (const event of PROCESS_CLEANUP_EVENTS) {
          for (const listener of processEvents.listeners(event)) {
            if (!listenersBefore.get(event)!.includes(listener)) {
              processEvents.removeListener(event, listener as ProcessListener);
            }
          }
        }
      }
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
