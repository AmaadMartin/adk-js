/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {Console} from 'node:console';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import type {Mock} from 'vitest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {App} from '@google/adk';
import {isApp, LogLevel} from '@google/adk';
import {
  AgentFile,
  AgentLoader,
  AgentNotFoundError,
  FileModuleType,
  isAgentNotFoundError,
  replaceDirnamePlugin,
} from '../../src/utils/agent_loader.js';
import * as fileUtils from '../../src/utils/file_utils.js';
import {AdkLogger, setDefaultLogLevel} from '../../src/utils/logger.js';

vi.mock('../../src/utils/file_utils.js', () => ({
  createTempDir: vi.fn(),
  isFile: vi.fn(),
  isFileExists: vi.fn(),
  isFolderExists: vi.fn(),
  removeFolder: vi.fn(),
  tryToFindFolderRecursively: vi.fn(),
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
 * Compiled fixture paths already produced during this file's run.
 *
 * Two tests that compile to the same path do not get two modules: the module
 * runner hands the second `import()` the module the first test already
 * evaluated. `AgentFile`'s `?t=` cache-buster is a real-Node-ESM device and
 * does not apply here, and deleting the file in `afterEach` does not evict the
 * module either. The second test then asserts against the first test's agent -
 * a baffling failure when they expect different agents, and a silent false
 * green when they expect the same one.
 *
 * File-scoped deliberately: it mirrors a module registry that lives for the
 * whole file, so it must NOT be cleared in `beforeEach`/`afterEach`.
 */
const claimedCompiledFixtures = new Set<string>();

function claimCompiledFixture(outfile: string): void {
  if (claimedCompiledFixtures.has(outfile)) {
    throw new Error(
      `Compiled fixture '${path.basename(outfile)}' was already produced by ` +
        `another test in this file. Reusing it makes this test import the ` +
        `earlier test's module instead of its own, so it passes or fails for ` +
        `the wrong reason - give this test's agent file a unique name.`,
    );
  }
  claimedCompiledFixtures.add(outfile);
}

/** Mocks `esbuild.build` to emit `compiledContent` at the requested outfile. */
function mockCompiledOutput(compiledContent: string): void {
  (esbuild.build as Mock).mockImplementation(
    async (options: {outfile: string}) => {
      claimCompiledFixture(options.outfile);
      await fs.writeFile(options.outfile, compiledContent);
    },
  );
}

const agent1JsContent = `
import {BaseAgent} from '@google/adk';

class FakeAgent1 extends BaseAgent {
  constructor(name) {
    super({ name });
  }
}
exports.rootAgent = new FakeAgent1('agent1');`;

const workflowRootJsContent = `
import {node, Workflow} from '@google/adk';

exports.rootAgent = new Workflow({
  name: 'graph_root',
  edges: [['START', node(() => 'done', {name: 'step'})]],
});`;

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

const agent2MjsContentMocked = `
import {BaseAgent} from '@google/adk';

class FakeAgent2 extends BaseAgent {
  constructor(name) {
    super({ name });
  }
}
export const rootAgent = new FakeAgent2('agent2');
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

const appMultipleExportsContent = `
import {App, BaseAgent} from '@google/adk';

class FakeAgentForApp extends BaseAgent {
  constructor(name) {
    super({name});
  }
}

export const firstApp = new App({
  name: 'test_app_multi_1',
  rootAgent: new FakeAgentForApp('agent_for_app_1'),
});
export const secondApp = new App({
  name: 'test_app_multi_2',
  rootAgent: new FakeAgentForApp('agent_for_app_2'),
});
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
    (fileUtils.createTempDir as Mock).mockImplementation(async () => {
      await fs.mkdir(tempLoaderDir, {recursive: true});
      return tempLoaderDir;
    });
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
    (fileUtils.tryToFindFolderRecursively as Mock).mockImplementation(
      async (_sourceFolder, folderName) => path.join(tempAgentsDir, folderName),
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
    it('loads an agent file whose root is a bare Workflow', async () => {
      // A graph is a node, not an agent. The loader adapts it, so a sample can
      // export a Workflow directly rather than wrapping it in a Workflow.
      const agentPath = path.join(tempAgentsDir, 'graph_root.js');
      await fs.writeFile(agentPath, workflowRootJsContent);

      const compiledAgentPath = compiledPath('graph_root.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, workflowRootJsContent);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('graph_root');
      await agentFile.dispose();
    });

    it('loads .js agent file', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const compiledAgentPath = compiledPath('agent1.cjs');
      mockCompiledOutput(agent1JsContent);

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
      mockCompiledOutput(agent2CjsContentMocked);

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
        external: expect.arrayContaining(['onnxruntime-node']),
      });

      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('compiles into a private temp dir without allowing overwrite', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1_private_dir.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockCompiledOutput(agent1JsContent);

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();

      expect(fileUtils.createTempDir).toHaveBeenCalledWith('adk_agent_loader');
      expect(
        (esbuild.build as Mock).mock.calls[0][0].allowOverwrite,
      ).toBeUndefined();

      await agentFile.dispose();
    });

    it('marks the ADK packages external so each agent does not embed a copy', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent_external.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      mockCompiledOutput(agent2CjsContentMocked);

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();

      expect((esbuild.build as Mock).mock.calls[0][0].external).toEqual(
        expect.arrayContaining(['@google/adk', '@google/adk-devtools']),
      );

      await agentFile.dispose();
    });

    it('throws if rootAgent is not found', async () => {
      const agentPath = path.join(tempAgentsDir, 'bad_agent.js');
      await fs.writeFile(agentPath, 'exports.someOther = 1;');

      const compiledAgentPath = compiledPath('bad_agent.cjs');
      mockCompiledOutput('exports.someOther = 1;');

      const agentFile = new AgentFile(agentPath);
      await expect(agentFile.load()).rejects.toThrow(
        `Failed to load agent ${
          compiledAgentPath
        }: No @google/adk BaseAgent or Workflow instance found. Please check that file is not empty and it exports an @google/adk BaseAgent (e.g. LlmAgent) or Workflow instance.`,
      );
      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('links an ancestor node_modules into the compiled output directory', async () => {
      const nestedDir = path.join(tempAgentsDir, 'nested');
      await fs.mkdir(nestedDir, {recursive: true});
      const agentPath = path.join(nestedDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();

      await expect(fs.readlink(compiledPath('node_modules'))).resolves.toBe(
        path.join(tempAgentsDir, 'node_modules'),
      );
      expect(fileUtils.tryToFindFolderRecursively).toHaveBeenCalledWith(
        nestedDir,
        'node_modules',
        10,
      );

      await agentFile.dispose();
    });

    it('skips the node_modules link when no ancestor has one', async () => {
      (fileUtils.tryToFindFolderRecursively as Mock).mockRejectedValue(
        new Error('No node_modules found in /nowhere'),
      );
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const compiledAgentPath = compiledPath('agent1.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent1JsContent);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();

      await expect(fs.access(compiledPath('node_modules'))).rejects.toThrow();

      await agentFile.dispose();
    });

    it('throws when getting file path if agent is not loaded', () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      const agentFile = new AgentFile(agentPath);
      expect(() => agentFile.getFilePath()).toThrow('Agent is not loaded yet');
    });

    it('throws when getting file path if agent is disposed', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1_disposed.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockCompiledOutput(agent1JsContent);

      const agentFile = new AgentFile(agentPath);
      await agentFile.load();
      await agentFile.dispose();
      expect(() => agentFile.getFilePath()).toThrow(
        'Agent is disposed and can not be used',
      );
    });

    it('returns cleanup file path if compiled', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2_cleanup.ts');
      const compiledAgentPath = compiledPath('agent2_cleanup.cjs');
      await fs.writeFile(agentPath, agent2TsContent);

      mockCompiledOutput(agent2CjsContentMocked);

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

    it('throws when getting file path if an uncompiled agent is disposed', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const agentFile = new AgentFile(agentPath, {
        compile: false,
        bundle: false,
      });
      await agentFile.load();
      await agentFile.dispose();

      expect(() => agentFile.getFilePath()).toThrow(
        'Agent is disposed and can not be used',
      );
    });

    it('disposes an uncompiled agent file without touching the filesystem', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const agentFile = new AgentFile(agentPath, {
        compile: false,
        bundle: false,
      });
      await agentFile.load();
      await agentFile.dispose();
      await agentFile.dispose();

      await expect(fs.access(agentPath)).resolves.toBeUndefined();
      expect(fileUtils.removeFolder).not.toHaveBeenCalled();
    });

    it('inherits the compile and bundle defaults when only moduleType is given', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      const compiledAgentPath = compiledPath('agent2.mjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent2MjsContentMocked);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath, {
        moduleType: FileModuleType.ESM,
      });
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent2');
      expect(esbuild.build).toHaveBeenCalledWith(
        expect.objectContaining({
          outfile: compiledAgentPath,
          format: 'esm',
          bundle: true,
          minify: true,
        }),
      );

      await agentFile.dispose();
    });

    it('inherits the bundle default when only compile is given', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      const compiledAgentPath = compiledPath('agent2.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent2CjsContentMocked);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath, {compile: true});
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent2');
      expect(esbuild.build).toHaveBeenCalledWith(
        expect.objectContaining({bundle: true, minify: true}),
      );

      await agentFile.dispose();
    });

    it('inherits the compile default when only bundle is given', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      const compiledAgentPath = compiledPath('agent2.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAgentPath, agent2CjsContentMocked);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath, {bundle: false});
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent2');
      expect(esbuild.build).toHaveBeenCalledWith(
        expect.objectContaining({bundle: false, minify: false}),
      );

      await agentFile.dispose();
    });

    it('does not compile when compile and bundle are explicitly false', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1.js');
      await fs.writeFile(agentPath, agent1JsContent);

      const agentFile = new AgentFile(agentPath, {
        compile: false,
        bundle: false,
      });
      await agentFile.load();

      expect(esbuild.build).not.toHaveBeenCalled();

      await agentFile.dispose();
    });

    it('loads agent with default export', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent_default.js');
      await fs.writeFile(agentPath, agentDefaultExportContent);

      const compiledAgentPath = compiledPath('agent_default.cjs');
      mockCompiledOutput(agentDefaultExportContent);

      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agentDefault');
      await agentFile.dispose();
      await expect(fs.access(compiledAgentPath)).rejects.toThrow();
    });

    it('loads an app file and returns the app via load()', async () => {
      const appPath = path.join(tempAgentsDir, 'app1.js');
      await fs.writeFile(appPath, appJsContent);

      mockCompiledOutput(appJsContent);

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

      mockCompiledOutput(appDefaultExportContent);

      const agentFile = new AgentFile(appPath);
      const app = await agentFile.loadApp();
      const agent = await agentFile.loadAgent();

      expect(app.name).toBe('test_app_default');
      expect(agent.name).toBe('agent_for_app_default');
      await agentFile.dispose();
    });

    it('synthesizes an App when loadApp() is called on a BaseAgent file', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1_as_app.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockCompiledOutput(agent1JsContent);

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
      mockCompiledOutput(agentMultipleExportsContent);

      const warnSpy = vi
        .spyOn(AdkLogger.prototype, 'warn')
        .mockImplementation(() => {});
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const agentFile = new AgentFile(agentPath);
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent1');
      expect(warnSpy).toHaveBeenCalledWith(
        `Multiple agents found in ${compiledAgentPath}. Using the agent1 as a root agent.`,
      );
      expect(consoleSpy).not.toHaveBeenCalled();
      await agentFile.dispose();
      warnSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('warns through the logger when multiple apps are exported', async () => {
      const appPath = path.join(tempAgentsDir, 'app_multiple.js');
      await fs.writeFile(appPath, appMultipleExportsContent);

      const compiledAppPath = compiledPath('app_multiple.cjs');
      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledAppPath, appMultipleExportsContent);
        return Promise.resolve();
      });

      const warnSpy = vi
        .spyOn(AdkLogger.prototype, 'warn')
        .mockImplementation(() => {});
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const agentFile = new AgentFile(appPath);
      const loaded = await agentFile.load();

      expect(isApp(loaded)).toBe(true);
      expect((loaded as App).name).toBe('test_app_multi_1');
      expect(warnSpy).toHaveBeenCalledWith(
        `Multiple apps found in ${compiledAppPath}. Using the test_app_multi_1 as a root app.`,
      );
      expect(consoleSpy).not.toHaveBeenCalled();
      await agentFile.dispose();
      warnSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('caches loaded agent instance', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent1_cached.js');
      await fs.writeFile(agentPath, agent1JsContent);

      mockCompiledOutput(agent1JsContent);

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
    type OnLoadCallback = (
      args: esbuild.OnLoadArgs,
    ) => Promise<esbuild.OnLoadResult | undefined>;

    const onLoadArgs = (modulePath: string): esbuild.OnLoadArgs => ({
      path: modulePath,
      namespace: 'file',
      suffix: '',
      pluginData: undefined,
      with: {},
    });

    const setupOnLoad = (): OnLoadCallback => {
      const onLoad =
        vi.fn<
          (options: esbuild.OnLoadOptions, callback: OnLoadCallback) => void
        >();
      replaceDirnamePlugin().setup({onLoad});
      return onLoad.mock.calls[0][1];
    };

    /** Writes a module inside an installed package and returns its path. */
    const writeDependency = async (
      packageName: string,
      fileName: string,
      contents: string,
    ): Promise<string> => {
      const packageDir = path.join(tempAgentsDir, 'node_modules', packageName);
      await fs.mkdir(packageDir, {recursive: true});
      const modulePath = path.join(packageDir, fileName);
      await fs.writeFile(modulePath, contents);
      return modulePath;
    };

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
      const plugin = replaceDirnamePlugin();

      expect(plugin.name).toBe('replace-dirname');

      const mockBuild = {
        onLoad: vi.fn(),
      };

      plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

      expect(mockBuild.onLoad).toHaveBeenCalledWith(
        {filter: /.*/, namespace: 'file'},
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
      const plugin = replaceDirnamePlugin();

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

    it('rewrites import.meta.url in a dependency to the dependency URL', async () => {
      const entryPath = path.join(tempAgentsDir, 'test_agent.ts');
      const modulePath = await writeDependency(
        'url-dep',
        'index.js',
        'const url = import.meta.url;',
      );
      const onLoadCallback = setupOnLoad();

      const result = await onLoadCallback(onLoadArgs(modulePath));

      expect(result?.contents).toContain(pathToFileURL(modulePath).href);
      expect(result?.contents).not.toContain(pathToFileURL(entryPath).href);
    });

    it('rewrites __dirname and __filename in a dependency to the dependency location', async () => {
      const modulePath = await writeDependency(
        'dirname-dep',
        'index.js',
        'const dir = __dirname;\nconst file = __filename;',
      );
      const onLoadCallback = setupOnLoad();

      const result = await onLoadCallback(onLoadArgs(modulePath));

      expect(result?.contents).toContain(
        JSON.stringify(path.dirname(modulePath)),
      );
      expect(result?.contents).toContain(JSON.stringify(modulePath));
      expect(result?.contents).not.toContain(JSON.stringify(tempAgentsDir));
    });

    it('rewrites import.meta.dirname and import.meta.filename in a dependency', async () => {
      const modulePath = await writeDependency(
        'meta-dep',
        'index.js',
        'const dir = import.meta.dirname;\nconst file = import.meta.filename;',
      );
      const onLoadCallback = setupOnLoad();

      const result = await onLoadCallback(onLoadArgs(modulePath));

      expect(result?.contents).toContain(
        JSON.stringify(path.dirname(modulePath)),
      );
      expect(result?.contents).toContain(JSON.stringify(modulePath));
      expect(result?.contents).not.toContain('import.meta');
    });

    it('does not replace tokens in strings in a dependency', async () => {
      const modulePath = await writeDependency(
        'string-dep',
        'index.js',
        `const str = "__dirname";\nconst code = __dirname;`,
      );
      const onLoadCallback = setupOnLoad();

      const result = await onLoadCallback(onLoadArgs(modulePath));

      expect(result?.contents).toContain('const str = "__dirname"');
      expect(result?.contents).toContain(
        JSON.stringify(path.dirname(modulePath)),
      );
    });

    it('does not transform a module without location tokens', async () => {
      const modulePath = await writeDependency(
        'plain-dep',
        'index.js',
        'export const answer = 1;',
      );
      const onLoadCallback = setupOnLoad();

      const result = await onLoadCallback(onLoadArgs(modulePath));

      expect(result).toBeUndefined();
    });

    it.each([
      ['tsx', 'const url: string = import.meta.url;'],
      ['jsx', 'const url = import.meta.url;'],
    ])(
      'rewrites a .%s dependency and leaves its JSX for the build',
      async (extension: string, contents: string) => {
        const modulePath = await writeDependency(
          `${extension}-dep`,
          `index.${extension}`,
          `${contents}\nexport const node = <div className="x">hi</div>;`,
        );
        const onLoadCallback = setupOnLoad();

        const result = await onLoadCallback(onLoadArgs(modulePath));

        expect(result?.contents).toContain(pathToFileURL(modulePath).href);
        expect(result?.contents).toContain('<div className="x">hi</div>');
        expect(result?.loader).toBe('jsx');
      },
    );

    it('does not replace a location token that the module declares itself', async () => {
      const modulePath = await writeDependency(
        'shim-dep',
        'index.js',
        [
          'import {fileURLToPath} from "node:url";',
          'import * as path from "node:path";',
          'const __filename = fileURLToPath(import.meta.url);',
          'const __dirname = path.dirname(__filename);',
          'export const dir = __dirname;',
        ].join('\n'),
      );
      const onLoadCallback = setupOnLoad();

      const result = await onLoadCallback(onLoadArgs(modulePath));

      expect(result?.contents).toContain('const __filename = fileURLToPath(');
      expect(result?.contents).toContain('const __dirname = path.dirname(');
      expect(result?.contents).toContain(pathToFileURL(modulePath).href);
    });

    it('does not transform a non-JavaScript file', async () => {
      const modulePath = await writeDependency(
        'json-dep',
        'data.json',
        '{"key": "__dirname"}',
      );
      const onLoadCallback = setupOnLoad();

      const result = await onLoadCallback(onLoadArgs(modulePath));

      expect(result).toBeUndefined();
    });

    it('reports a syntax error against the module that holds it', async () => {
      const modulePath = await writeDependency(
        'broken-dep',
        'index.js',
        'const dir = __dirname; const;',
      );
      const onLoadCallback = setupOnLoad();

      await expect(onLoadCallback(onLoadArgs(modulePath))).rejects.toThrow(
        modulePath,
      );
    });

    it('fails when a module cannot be read', async () => {
      const modulePath = path.join(
        tempAgentsDir,
        'node_modules',
        'absent-dep',
        'index.js',
      );
      const onLoadCallback = setupOnLoad();

      await expect(onLoadCallback(onLoadArgs(modulePath))).rejects.toThrow(
        'ENOENT',
      );
    });

    it('uses js loader for non-ts files', async () => {
      const filePath = path.join(tempAgentsDir, 'test_agent.js');
      const plugin = replaceDirnamePlugin();

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
      const plugin = replaceDirnamePlugin();

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
      const plugin = replaceDirnamePlugin();

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
      (fileUtils.createTempDir as Mock).mockImplementation(async () => {
        await fs.mkdir(tempLoaderDir, {recursive: true});
        return fs.mkdtemp(path.join(tempLoaderDir, 'agent-'));
      });

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
          claimCompiledFixture(options.outfile);
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

    it('forwards options merged with the defaults to every agent file', async () => {
      // The third positional argument pins that `watchForChanges` kept its slot.
      const agentLoader = new AgentLoader(
        tempAgentsDir,
        {bundle: false},
        false,
      );

      const agents = await agentLoader.listAgents();

      // `compile` fell back to its default, so every agent was still built,
      // while the caller's explicit `bundle: false` survived the merge.
      expect(agents).toEqual(['agent1', 'agent2', 'agent3']);
      expect(esbuild.build).toHaveBeenCalledTimes(3);
      for (const [buildOptions] of (esbuild.build as Mock).mock.calls) {
        expect(buildOptions).toMatchObject({bundle: false, minify: false});
      }

      await agentLoader.disposeAll();
    });

    it('gets agent file', async () => {
      const agentLoader = new AgentLoader(tempAgentsDir);
      const agentFile = await agentLoader.getAgentFile('agent1');
      const agent = await agentFile.load();
      expect(agent.name).toEqual('agent1');
      await agentLoader.disposeAll();
    });

    /**
     * A helper module beside the agents is skipped, not broken, so logging the
     * skip must not promote it to a load failure.
     */
    it('keeps a skipped non-agent file out of the load failures', async () => {
      await fs.writeFile(
        path.join(tempAgentsDir, 'helper.js'),
        'exports.notAnAgent = 42;',
      );
      const loader = new AgentLoader(tempAgentsDir);

      await expect(loader.listAgents()).resolves.toEqual([
        'agent1',
        'agent2',
        'agent3',
      ]);
      await expect(loader.listLoadFailures()).resolves.toEqual([]);
      await expect(loader.getAgentFile('helper')).rejects.toThrow(
        /Agent 'helper' not found[\s\S]*Available agents: agent1, agent2, agent3/,
      );
      await loader.disposeAll();
    });

    /**
     * An agent whose module throws while constructing (a malformed workflow
     * graph, a bad config) must not stop the other agents from loading —
     * otherwise a single broken file takes the whole server down with it.
     */
    describe('when one agent fails to construct', () => {
      beforeEach(async () => {
        await fs.mkdir(path.join(tempAgentsDir, 'broken'), {recursive: true});
        await fs.writeFile(
          path.join(tempAgentsDir, 'broken', 'agent.js'),
          `throw new Error('boom during construction');`,
        );
      });

      it('still lists the healthy agents', async () => {
        const loader = new AgentLoader(tempAgentsDir);

        const agents = await loader.listAgents();

        expect(agents).toEqual(['agent1', 'agent2', 'agent3']);
        await loader.disposeAll();
      });

      it('still loads a healthy agent', async () => {
        const loader = new AgentLoader(tempAgentsDir);

        const agentFile = await loader.getAgentFile('agent1');
        const agent = await agentFile.load();

        expect(agent.name).toEqual('agent1');
        await loader.disposeAll();
      });

      it('reports the failure against the agent that caused it', async () => {
        const loader = new AgentLoader(tempAgentsDir);

        const failures = await loader.listLoadFailures();

        expect(failures).toHaveLength(1);
        expect(failures[0].name).toBe('broken');
        expect(failures[0].filePath).toContain('broken');
        expect(failures[0].error.message).toContain('boom during construction');
        await loader.disposeAll();
      });

      it('rethrows the original error when the broken agent is requested', async () => {
        const loader = new AgentLoader(tempAgentsDir);

        await expect(loader.getAgentFile('broken')).rejects.toThrow(
          /Agent 'broken' failed to load[\s\S]*boom during construction/,
        );
        await loader.disposeAll();
      });

      it('reports available agents when the name is simply unknown', async () => {
        const loader = new AgentLoader(tempAgentsDir);

        await expect(loader.getAgentFile('nope')).rejects.toThrow(
          /Agent 'nope' not found[\s\S]*Available agents: agent1, agent2, agent3/,
        );
        await loader.disposeAll();
      });

      it('throws AgentNotFoundError when the name is unknown', async () => {
        const loader = new AgentLoader(tempAgentsDir);

        const error = await loader.getAgentFile('nope').catch((e) => e);

        expect(error).toBeInstanceOf(AgentNotFoundError);
        expect((error as Error).name).toBe('AgentNotFoundError');
        expect(isAgentNotFoundError(error)).toBe(true);
        await loader.disposeAll();
      });

      it('getAppFile throws AgentNotFoundError for an unknown app', async () => {
        const loader = new AgentLoader(tempAgentsDir);

        const error = await loader.getAppFile('nope').catch((e) => e);

        expect(error).toBeInstanceOf(AgentNotFoundError);
        expect(isAgentNotFoundError(error)).toBe(true);
        await loader.disposeAll();
      });

      it('does not report a broken agent as not found', async () => {
        const loader = new AgentLoader(tempAgentsDir);

        const error = await loader.getAgentFile('broken').catch((e) => e);

        expect(isAgentNotFoundError(error)).toBe(false);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('failed to load');
        await loader.disposeAll();
      });

      it('isAgentNotFoundError rejects unrelated values', () => {
        expect(isAgentNotFoundError(new Error('x'))).toBe(false);
        expect(isAgentNotFoundError(undefined)).toBe(false);
        expect(isAgentNotFoundError({name: 'AgentNotFoundError'})).toBe(false);
      });
    });

    it('returns the same shared AgentFile instance for repeated getAgentFile calls', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const first = await loader.getAgentFile('agent2');
      const second = await loader.getAgentFile('agent2');

      expect(second).toBe(first);

      await first.load();
      await first.dispose();
      const afterDispose = await loader.getAgentFile('agent2');

      expect(() => afterDispose.getFilePath()).toThrow(
        'Agent is disposed and can not be used',
      );

      await loader.disposeAll();
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

    it('ignores node_modules and hidden dot directories during discovery', async () => {
      // Create agent inside node_modules directory
      const nodeModulesDir = path.join(tempAgentsDir, 'node_modules');
      await fs.mkdir(nodeModulesDir, {recursive: true});
      await fs.writeFile(
        path.join(nodeModulesDir, 'agent.js'),
        agent3JsContent,
      );

      // Create agent inside a hidden dot directory
      const hiddenDir = path.join(tempAgentsDir, '.hidden');
      await fs.mkdir(hiddenDir, {recursive: true});
      await fs.writeFile(path.join(hiddenDir, 'agent.js'), agent3JsContent);

      const loader = new AgentLoader(tempAgentsDir);
      const agents = await loader.listAgents();

      expect(agents).toEqual(['agent1', 'agent2', 'agent3']);
      expect(agents).not.toContain('node_modules');
      expect(agents).not.toContain('.hidden');

      await loader.disposeAll();
    });

    /**
     * The entrypoint each esbuild invocation compiled, in call order.
     * Comparing the list against its distinct entries counts duplicated
     * discovery work without hardcoding how many entrypoints the fixture has.
     */
    function compiledEntryPoints(): string[] {
      return (esbuild.build as Mock).mock.calls.map(
        (call) => (call[0] as {entryPoints: string[]}).entryPoints[0],
      );
    }

    it('runs a single discovery pass for concurrent preloadAgents() calls', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      await Promise.all([loader.preloadAgents(), loader.preloadAgents()]);

      const compiled = compiledEntryPoints();
      expect(compiled.length).toBe(new Set(compiled).size);
      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);

      await loader.disposeAll();
    });

    it('re-scans after a failed discovery pass instead of replaying its rejection', async () => {
      const compileAgent = (esbuild.build as Mock).getMockImplementation();
      let compilesFail = true;
      (esbuild.build as Mock).mockImplementation(
        async (options: {entryPoints: string[]; outfile: string}) => {
          if (compilesFail) {
            throw new Error('compile failed');
          }

          return compileAgent?.(options);
        },
      );

      const loader = new AgentLoader(tempAgentsDir);
      await expect(loader.preloadAgents()).rejects.toThrow('compile failed');

      compilesFail = false;

      await expect(loader.preloadAgents()).resolves.toBeUndefined();
      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);

      await loader.disposeAll();
    });

    it('starts a fresh scan when invalidateAll is called during a scan', async () => {
      const loader = new AgentLoader(tempAgentsDir);
      const invalidatedScan = loader.preloadAgents();

      (loader as unknown as {invalidateAll: () => void}).invalidateAll();

      await Promise.all([invalidatedScan, loader.preloadAgents()]);

      // Every entrypoint is compiled once by the discarded scan and once by
      // its replacement.
      const compiled = compiledEntryPoints();
      expect(compiled.length).toBe(2 * new Set(compiled).size);

      // The replacement scan completed, so listing serves it from the cache
      // instead of scanning a third time.
      expect(await loader.listAgents()).toEqual(['agent1', 'agent2', 'agent3']);
      expect(compiledEntryPoints().length).toBe(compiled.length);

      await loader.disposeAll();
    });
  });

  describe('compiled fixture collision guard', () => {
    it('rejects a second compile to a fixture name another test already used', async () => {
      const agentPath = path.join(tempAgentsDir, 'guard_duplicate.js');
      await fs.writeFile(agentPath, agent1JsContent);
      mockCompiledOutput(agent1JsContent);

      const first = new AgentFile(agentPath);
      await first.load();

      const second = new AgentFile(agentPath);
      await expect(second.load()).rejects.toThrow(
        /Compiled fixture 'guard_duplicate\.cjs' was already produced/,
      );

      await first.dispose();
    });
  });
  /**
   * The scan is silent by default and inspectable at debug level, so a file
   * that was skipped can be told apart from a file that was never scanned.
   */
  describe('skipped files', () => {
    let writes: string[];
    let compiled: string[];
    let originalConsole: Console;

    beforeEach(() => {
      writes = [];
      compiled = [];
      const sink = new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          writes.push(chunk.toString());
          callback();
        },
      });
      originalConsole = globalThis.console;
      // winston's Console transport writes to `console._stdout`, which Vitest
      // has already replaced with its own reporting stream. Swapping the whole
      // console is what puts the records in reach.
      globalThis.console = new Console({stdout: sink, stderr: sink});
    });

    afterEach(() => {
      globalThis.console = originalConsole;
      setDefaultLogLevel(LogLevel.INFO);
      (esbuild.build as Mock).mockReset();
    });

    /** Writes a module that exports no agent, compiled through verbatim. */
    async function writeNonAgentFile(name: string): Promise<string> {
      const filePath = path.join(tempAgentsDir, `${name}.js`);
      await fs.writeFile(filePath, 'exports.notAnAgent = 42;');
      (esbuild.build as Mock).mockImplementation(
        async (options: {entryPoints: string[]; outfile: string}) => {
          compiled.push(options.entryPoints[0]);
          await fs.writeFile(
            options.outfile,
            await fs.readFile(options.entryPoints[0], 'utf8'),
          );
        },
      );
      return filePath;
    }

    function flush(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    it('names the skipped file at debug level', async () => {
      const helperPath = await writeNonAgentFile('debug_helper');
      setDefaultLogLevel(LogLevel.DEBUG);
      const loader = new AgentLoader(tempAgentsDir);

      const agents = await loader.listAgents();
      await flush();
      await loader.disposeAll();

      expect(agents).not.toContain('debug_helper');
      const output = writes.join('');
      expect(output).toContain(`Skipped ${helperPath}`);
      expect(output).toContain(
        'No @google/adk BaseAgent or Workflow instance found',
      );
    });

    it('says nothing about the skipped file at the default level', async () => {
      const helperPath = await writeNonAgentFile('quiet_helper');
      const loader = new AgentLoader(tempAgentsDir);

      const agents = await loader.listAgents();
      await flush();
      await loader.disposeAll();

      expect(agents).not.toContain('quiet_helper');
      // The loader compiled the file, so the missing line is silence about a
      // scanned file rather than a file the scan never reached.
      expect(compiled).toContain(helperPath);
      expect(writes.join('')).not.toContain('Skipped ');
    });
  });
});
