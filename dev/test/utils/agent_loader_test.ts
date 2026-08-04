/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
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
  FileMetadata,
  isAgentEntrypointFile,
  isScannableDirectory,
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

const {watchMock} = vi.hoisted(() => ({
  watchMock:
    vi.fn<
      (
        dir: string,
        options: {recursive: boolean},
        listener: (event: string, filename: string | undefined) => void,
      ) => {on: () => void; close: () => void}
    >(),
}));

/** Replays a watcher event onto the listener the loader registered. */
function notifyWatcher(event: string, filename: string | undefined): void {
  watchMock.mock.calls[0][2](event, filename);
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, default: {...actual, watch: watchMock}, watch: watchMock};
});

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

  describe('discovery filters', () => {
    const fileEntry = (fileName: string): FileMetadata => {
      const ext = path.extname(fileName);
      return {
        path: path.join('/agents', fileName),
        name: fileName.slice(0, fileName.length - ext.length),
        ext,
        isFile: true,
        isDirectory: false,
      };
    };

    const dirEntry = (dirName: string): FileMetadata => ({
      path: path.join('/agents', dirName),
      name: dirName,
      isFile: false,
      isDirectory: true,
    });

    it.each([
      ['agent.js', true],
      ['agent.ts', true],
      ['agent.mts', true],
      ['agent.cjs', true],
      ['agent.py', false],
      ['agent.json', false],
      // `.d.ts` needs the separating dot: `ad.ts` is an ordinary agent file.
      ['ad.ts', true],
      ['a.d.ts', false],
      ['a.d.mts', false],
      ['a.d.cts', false],
      // Likewise `.spec.` / `.test.` need the separating dot.
      ['xspec.ts', true],
      ['x.spec.mts', false],
      ['x.test.js', false],
      ['x.spec.cjs', false],
      ['.hidden.ts', false],
    ])('isAgentEntrypointFile(%s) is %s', (fileName, expected) => {
      expect(isAgentEntrypointFile(fileEntry(fileName))).toBe(expected);
    });

    it('isAgentEntrypointFile rejects a directory entry', () => {
      expect(isAgentEntrypointFile(dirEntry('agent.ts'))).toBe(false);
    });

    it.each([
      ['my_agent', true],
      ['node_modules', false],
      ['dist', false],
      ['build', false],
      ['.git', false],
    ])('isScannableDirectory(%s) is %s', (dirName, expected) => {
      expect(isScannableDirectory(dirEntry(dirName))).toBe(expected);
    });

    it('isScannableDirectory rejects a file entry', () => {
      expect(isScannableDirectory(fileEntry('my_agent.ts'))).toBe(false);
    });
  });

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

    it('does not rescan the agents directory once discovery has run', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      await loader.discoverAgents();

      // `isFile` is consulted exactly once per scan, on the agents dir itself.
      (fileUtils.isFile as Mock).mockClear();
      await loader.discoverAgents();

      expect(fileUtils.isFile).not.toHaveBeenCalled();
      await loader.disposeAll();
    });

    it('lists a directory whose entrypoint exports no agent but excludes it from apps', async () => {
      await fs.mkdir(path.join(tempAgentsDir, 'bad_agent_dir'));
      await fs.writeFile(
        path.join(tempAgentsDir, 'bad_agent_dir', 'agent.js'),
        'exports.foo = "bar";',
      );

      const loader = new AgentLoader(tempAgentsDir);

      expect(await loader.listAgents()).toContain('bad_agent_dir');
      expect(await loader.listApps()).not.toContain('bad_agent_dir');

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

    it('rescans the agents directory after a reported file change', async () => {
      watchMock.mockReturnValue({on: vi.fn(), close: vi.fn()});
      const loader = new AgentLoader(tempAgentsDir, undefined, true);

      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);

      await fs.writeFile(
        path.join(tempAgentsDir, 'agent4.js'),
        agent1JsContent,
      );

      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);

      notifyWatcher('change', 'agent4.js');

      expect(await loader.listAgents()).toEqual([
        'agent1',
        'agent2',
        'agent3',
        'agent4',
      ]);

      await loader.disposeAll();
    });

    it('lists agents without compiling any of them', async () => {
      const loader = new AgentLoader(tempAgentsDir);

      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);
      expect(esbuild.build).not.toHaveBeenCalled();

      await loader.disposeAll();
    });

    it('returns an unloaded handle from getAgentFile()', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const agentFile = await loader.getAgentFile('agent2');

      expect(() => agentFile.getFilePath()).toThrow('Agent is not loaded yet');
      expect(esbuild.build).not.toHaveBeenCalled();

      await loader.disposeAll();
    });

    it('compiles only the agent that is actually loaded', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const agentFile = await loader.getAgentFile('agent2');

      expect((await agentFile.load()).name).toBe('agent2');
      expect(esbuild.build).toHaveBeenCalledTimes(1);
      expect((esbuild.build as Mock).mock.calls[0][0]).toMatchObject({
        entryPoints: [path.join(tempAgentsDir, 'agent2.ts')],
      });

      await loader.disposeAll();
    });

    it('loads candidates and lists only the App entrypoints', async () => {
      const appDir = path.join(tempAgentsDir, 'my_service');
      await fs.mkdir(appDir, {recursive: true});
      await fs.writeFile(path.join(appDir, 'app.js'), appJsContent);

      const loader = new AgentLoader(tempAgentsDir);

      expect(await loader.listApps()).toEqual(['my_service']);
      expect(esbuild.build).toHaveBeenCalled();

      await loader.disposeAll();
    });

    it('excludes dotfiles, declaration files and test files from discovery', async () => {
      await fs.writeFile(
        path.join(tempAgentsDir, 'helpers.d.ts'),
        'export {};',
      );
      await fs.writeFile(
        path.join(tempAgentsDir, 'agent.test.ts'),
        agent2TsContent,
      );
      await fs.writeFile(
        path.join(tempAgentsDir, '.hidden.ts'),
        agent2TsContent,
      );

      const loader = new AgentLoader(tempAgentsDir);

      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);

      await loader.disposeAll();
    });

    it('does not scan node_modules, dist, build or dot-directories', async () => {
      const nodeModulesAgent = path.join(
        tempAgentsDir,
        'node_modules',
        'agent.js',
      );
      await fs.writeFile(nodeModulesAgent, agent1JsContent);
      for (const dirName of ['dist', 'build', '.cache']) {
        await fs.mkdir(path.join(tempAgentsDir, dirName));
        await fs.writeFile(
          path.join(tempAgentsDir, dirName, 'agent.js'),
          agent1JsContent,
        );
      }

      const loader = new AgentLoader(tempAgentsDir);

      try {
        expect(await loader.listAgents()).toEqual([
          'agent1',
          'agent2',
          'agent3',
        ]);
      } finally {
        // `node_modules` survives the per-test cleanup, so undo this one here.
        await fs.rm(nodeModulesAgent, {force: true});
        await loader.disposeAll();
      }
    });

    it('does not discover a directory without an app or agent entrypoint', async () => {
      const dirPath = path.join(tempAgentsDir, 'just_a_library');
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, 'index.js'), agent1JsContent);

      const loader = new AgentLoader(tempAgentsDir);

      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);

      await loader.disposeAll();
    });

    it('scans once for concurrent listAgents() callers', async () => {
      const loader = new AgentLoader(tempAgentsDir);

      // `isFile` is consulted exactly once per scan, on the agents dir itself.
      (fileUtils.isFile as Mock).mockClear();
      const results = await Promise.all([
        loader.listAgents(),
        loader.listAgents(),
        loader.listAgents(),
      ]);

      expect(fileUtils.isFile).toHaveBeenCalledTimes(1);
      expect(results).toEqual([
        ['agent1', 'agent2', 'agent3'],
        ['agent1', 'agent2', 'agent3'],
        ['agent1', 'agent2', 'agent3'],
      ]);

      await loader.disposeAll();
    });

    it('compiles once and returns one instance for concurrent load() calls', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const agentFile = await loader.getAgentFile('agent2');

      const [first, second, third] = await Promise.all([
        agentFile.load(),
        agentFile.load(),
        agentFile.load(),
      ]);

      expect(esbuild.build).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
      expect(third).toBe(first);

      await loader.disposeAll();
    });

    it('leaves no temp directory behind after concurrent load() calls', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const agentFile = await loader.getAgentFile('agent2');

      await Promise.all([agentFile.load(), agentFile.load(), agentFile.load()]);
      expect(await fs.readdir(tempLoaderDir)).toHaveLength(1);

      await loader.disposeAll();
      expect(await fs.readdir(tempLoaderDir)).toEqual([]);
    });

    it('does not start a second compile when dispose lands mid-load', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const agentFile = await loader.getAgentFile('agent2');

      let releaseBuild = () => {};
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      (esbuild.build as Mock).mockImplementation(
        async (options: {outfile: string}) => {
          await buildGate;
          await fs.writeFile(options.outfile, agent2CjsContentMocked);
        },
      );

      const first = agentFile.load();
      await agentFile.dispose();
      const second = agentFile.load();
      releaseBuild();
      await Promise.all([first, second]);

      expect(esbuild.build).toHaveBeenCalledTimes(1);

      await loader.disposeAll();
      expect(await fs.readdir(tempLoaderDir)).toEqual([]);
    });

    it('retries the compile after a failed load', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const agentFile = await loader.getAgentFile('agent2');
      (esbuild.build as Mock).mockRejectedValueOnce(
        new Error('compile failed'),
      );

      await expect(agentFile.load()).rejects.toThrow('compile failed');
      expect((await agentFile.load()).name).toBe('agent2');
      expect(esbuild.build).toHaveBeenCalledTimes(2);

      await loader.disposeAll();
    });

    it('lists a single agent without compiling when agentsDirPath is a file', async () => {
      (fileUtils.isFile as Mock).mockReturnValue(true);
      const loader = new AgentLoader(path.join(tempAgentsDir, 'agent1.js'));

      expect(await loader.listAgents()).toEqual(['agent1']);
      expect(esbuild.build).not.toHaveBeenCalled();

      await loader.disposeAll();
    });

    it('lists an explicitly named dot-prefixed agent file', async () => {
      const hiddenAgentPath = path.join(tempAgentsDir, '.hidden_agent.js');
      await fs.writeFile(hiddenAgentPath, agent1JsContent);
      (fileUtils.isFile as Mock).mockReturnValue(true);

      const loader = new AgentLoader(hiddenAgentPath);

      expect(await loader.listAgents()).toEqual(['.hidden_agent']);

      await loader.disposeAll();
    });

    it('starts one directory watcher when watchForChanges is set', async () => {
      const watcher = {on: vi.fn(), close: vi.fn()};
      watchMock.mockReturnValue(watcher);
      const loader = new AgentLoader(tempAgentsDir, undefined, true);

      await loader.listAgents();
      notifyWatcher('change', 'agent1.js');
      await loader.listAgents();

      expect(watchMock).toHaveBeenCalledTimes(1);
      expect(watchMock).toHaveBeenCalledWith(
        tempAgentsDir,
        {recursive: true},
        expect.any(Function),
      );

      await loader.disposeAll();
      expect(watcher.close).toHaveBeenCalled();
    });

    it('does not watch the agents directory by default', async () => {
      const loader = new AgentLoader(tempAgentsDir);

      await loader.listAgents();

      expect(watchMock).not.toHaveBeenCalled();
      await loader.disposeAll();
    });

    it('ignores a watcher event that is not about a JS file', async () => {
      watchMock.mockReturnValue({on: vi.fn(), close: vi.fn()});
      const loader = new AgentLoader(tempAgentsDir, undefined, true);
      await loader.listAgents();

      await fs.writeFile(
        path.join(tempAgentsDir, 'agent4.js'),
        agent1JsContent,
      );
      notifyWatcher('change', 'notes.md');
      notifyWatcher('change', undefined);

      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);

      await loader.disposeAll();
    });

    it('retries the scan after a failed discovery', async () => {
      const loader = new AgentLoader(path.join(tempAgentsDir, 'missing_dir'));

      await expect(loader.listAgents()).rejects.toThrow();

      await fs.mkdir(path.join(tempAgentsDir, 'missing_dir'));
      await fs.writeFile(
        path.join(tempAgentsDir, 'missing_dir', 'agent.js'),
        agent1JsContent,
      );

      expect(await loader.listAgents()).toEqual(['agent']);

      await loader.disposeAll();
    });
  });
});
