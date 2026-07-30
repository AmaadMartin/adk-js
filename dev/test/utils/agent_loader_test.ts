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
  isModuleResolutionError,
  replaceDirnamePlugin,
} from '../../src/utils/agent_loader.js';
import * as fileUtils from '../../src/utils/file_utils.js';
import {AdkLogger} from '../../src/utils/logger.js';

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

// An ESM default export re-exported through a CommonJS interop namespace, so
// the agent sits at `module.default.default`.
const agentNestedDefaultExportContent = `
const {BaseAgent} = require('@google/adk');

class FakeAgentNestedDefault extends BaseAgent {
  constructor(name) {
    super({name});
  }
}

exports.default = {default: new FakeAgentNestedDefault('agentNestedDefault')};
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

    // Reset rather than clear: a test that queues mockImplementationOnce
    // builds it never consumes would otherwise leak them into the next test.
    (esbuild.build as Mock).mockReset();
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
      expect(esbuild.build as Mock).toHaveBeenCalledTimes(1);
      expect((esbuild.build as Mock).mock.calls[0][0]).toMatchObject({
        entryPoints: [agentPath],
        outfile: compiledAgentPath,
        target: 'node16',
        platform: 'node',
        format: 'cjs',
        // The project's node_modules is linked into the output directory, so
        // third-party packages are left external instead of being inlined.
        packages: 'external',
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

    it('loads agent from a doubly-nested default export', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent_nested_default.js');
      await fs.writeFile(agentPath, agentNestedDefaultExportContent);

      (esbuild.build as Mock).mockImplementationOnce(async () =>
        fs.writeFile(
          compiledPath('agent_nested_default.cjs'),
          agentNestedDefaultExportContent,
        ),
      );

      const agentFile = new AgentFile(agentPath);

      expect((await agentFile.load()).name).toEqual('agentNestedDefault');

      await agentFile.dispose();
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

    it('omits esbuild "external" when bundling is disabled', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledPath('agent2.cjs'), agent2CjsContentMocked);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath, {
        compile: true,
        bundle: false,
      });
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent2');
      const buildOptions = (esbuild.build as Mock).mock.calls[0][0];
      expect(buildOptions).not.toHaveProperty('external');
      expect(buildOptions).toMatchObject({bundle: false, minify: false});

      await agentFile.dispose();
    });

    it('omits esbuild "external" when bundle option is not provided', async () => {
      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      (esbuild.build as Mock).mockImplementation(async () => {
        await fs.writeFile(compiledPath('agent2.cjs'), agent2CjsContentMocked);
        return Promise.resolve();
      });

      const agentFile = new AgentFile(agentPath, {compile: true});
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent2');
      expect((esbuild.build as Mock).mock.calls[0][0]).not.toHaveProperty(
        'external',
      );

      await agentFile.dispose();
    });

    it('compiles and loads a .ts agent with real esbuild when bundle is disabled', async () => {
      const {build: realEsbuildBuild} =
        await vi.importActual<typeof import('esbuild')>('esbuild');
      (esbuild.build as Mock).mockImplementationOnce(realEsbuildBuild);

      const agentPath = path.join(tempAgentsDir, 'agent2.ts');
      await fs.writeFile(agentPath, agent2TsContent);

      const agentFile = new AgentFile(agentPath, {
        compile: true,
        bundle: false,
      });
      const agent = await agentFile.load();

      expect(agent.name).toEqual('agent2');
      const compiled = await fs.readFile(compiledPath('agent2.cjs'), 'utf8');
      expect(compiled).toContain('require("@google/adk")');

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

  // Every test here needs its own agent name: vitest's module runner caches a
  // dynamic import by file path and ignores the cache-busting query, so two
  // tests compiling to the same artifact path would share the first module.
  describe('AgentFile dependency externalization', () => {
    const UNRESOLVABLE_REQUIRE = `require('adk-definitely-not-installed');`;
    const packagesOf = (callIndex: number) =>
      (esbuild.build as Mock).mock.calls[callIndex][0].packages;

    /**
     * Writes an agent source file and queues one mocked build per artifact
     * body, in the order the builds are expected to happen.
     */
    async function setUpAgent(name: string, ...artifactBodies: string[]) {
      const agentPath = path.join(tempAgentsDir, `${name}.ts`);
      await fs.writeFile(agentPath, agent2TsContent);

      for (const body of artifactBodies) {
        (esbuild.build as Mock).mockImplementationOnce(async () =>
          fs.writeFile(compiledPath(`${name}.cjs`), body),
        );
      }
      return agentPath;
    }

    it('inlines dependencies when the project has no package.json', async () => {
      const agentPath = await setUpAgent(
        'agent_no_pkg',
        agent2CjsContentMocked,
      );
      (fileUtils.tryToFindFileRecursively as Mock).mockRejectedValue(
        new Error('package.json not found'),
      );

      const agentFile = new AgentFile(agentPath);

      expect((await agentFile.load()).name).toEqual('agent2');
      expect(packagesOf(0)).toEqual('bundle');

      await agentFile.dispose();
    });

    it('inlines dependencies when the project has no node_modules', async () => {
      const agentPath = await setUpAgent('agent_no_nm', agent2CjsContentMocked);
      (fileUtils.isFolderExists as Mock).mockImplementation(
        async (folderPath) => !(folderPath as string).endsWith('node_modules'),
      );

      const agentFile = new AgentFile(agentPath);

      expect((await agentFile.load()).name).toEqual('agent2');
      expect(packagesOf(0)).toEqual('bundle');

      await agentFile.dispose();
    });

    it('keeps externalizing when the output directory is already linked', async () => {
      const agentPath = await setUpAgent(
        'agent_relink',
        agent2CjsContentMocked,
      );
      // Both the project's node_modules and the output directory's link to it
      // already exist, so no new symlink is created.
      (fileUtils.isFolderExists as Mock).mockResolvedValue(true);

      const agentFile = new AgentFile(agentPath);

      expect((await agentFile.load()).name).toEqual('agent2');
      expect(packagesOf(0)).toEqual('external');

      await agentFile.dispose();
    });

    it('inlines dependencies when bundling is disabled', async () => {
      const agentPath = await setUpAgent(
        'agent_nobundle',
        agent2CjsContentMocked,
      );

      const agentFile = new AgentFile(agentPath, {
        compile: true,
        bundle: false,
      });

      expect((await agentFile.load()).name).toEqual('agent2');
      // esbuild ignores `packages` when it is not bundling, so asking for
      // 'external' would only mislead the retry into a duplicate build.
      expect(packagesOf(0)).toEqual('bundle');

      await agentFile.dispose();
    });

    it('inlines dependencies when inlineDependencies is requested', async () => {
      const agentPath = await setUpAgent(
        'agent_inline',
        agent2CjsContentMocked,
      );

      const agentFile = new AgentFile(agentPath, {
        compile: true,
        bundle: true,
        inlineDependencies: true,
      });

      expect((await agentFile.load()).name).toEqual('agent2');
      expect(packagesOf(0)).toEqual('bundle');

      await agentFile.dispose();
    });

    it('rebuilds with dependencies inlined when an external package does not resolve', async () => {
      const agentPath = await setUpAgent(
        'agent_retry',
        UNRESOLVABLE_REQUIRE,
        agent2CjsContentMocked,
      );
      const warnSpy = vi
        .spyOn(AdkLogger.prototype, 'warn')
        .mockImplementation(() => {});

      const agentFile = new AgentFile(agentPath);

      // The retry replays the first failure here rather than picking up the
      // rebuilt artifact, because vitest's module runner has already cached
      // this artifact path. What this test pins is the rebuild decision; that
      // the retry then loads the agent is covered by the end-to-end run
      // against real Node described in the pull request.
      await expect(agentFile.load()).rejects.toThrow(
        "Cannot find module 'adk-definitely-not-installed'",
      );
      expect(esbuild.build as Mock).toHaveBeenCalledTimes(2);
      expect(packagesOf(0)).toEqual('external');
      expect(packagesOf(1)).toEqual('bundle');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot find module 'adk-definitely-not-installed'",
        ),
      );

      await agentFile.dispose();
    });

    it('does not rebuild when the agent fails for an unrelated reason', async () => {
      const agentPath = await setUpAgent(
        'agent_boom',
        `throw new Error('boom');`,
      );

      const agentFile = new AgentFile(agentPath);

      await expect(agentFile.load()).rejects.toThrow('boom');
      expect(esbuild.build as Mock).toHaveBeenCalledTimes(1);

      await agentFile.dispose();
    });

    it('does not rebuild when dependencies were already inlined', async () => {
      const agentPath = await setUpAgent(
        'agent_inline_fail',
        UNRESOLVABLE_REQUIRE,
      );

      const agentFile = new AgentFile(agentPath, {
        compile: true,
        bundle: true,
        inlineDependencies: true,
      });

      await expect(agentFile.load()).rejects.toThrow(
        "Cannot find module 'adk-definitely-not-installed'",
      );
      expect(esbuild.build as Mock).toHaveBeenCalledTimes(1);

      await agentFile.dispose();
    });
  });

  describe('isModuleResolutionError', () => {
    it.each(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM'])(
      'is true for %s',
      (code) => {
        expect(
          isModuleResolutionError(Object.assign(new Error('x'), {code})),
        ).toBe(true);
      },
    );

    it.each([
      // Inlining cannot repair an exports-map violation: esbuild honours
      // `exports` too, so retrying would only turn it into a build error.
      {
        name: 'a non-exported subpath',
        error: {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'},
      },
      {name: 'an unrelated code', error: {code: 'EACCES'}},
      {name: 'a codeless error', error: new Error('x')},
      {name: 'a non-string code', error: {code: 42}},
      {name: 'undefined', error: undefined},
      {name: 'null', error: null},
      {name: 'a string', error: 'ERR_MODULE_NOT_FOUND'},
    ])('is false for $name', ({error}) => {
      expect(isModuleResolutionError(error)).toBe(false);
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
