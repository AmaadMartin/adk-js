/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, BaseAgent, isApp, isBaseAgent} from '@google/adk';
import esbuild from 'esbuild';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {shimPlugin} from 'esbuild-shim-plugin';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

import {
  getTempDir,
  isFile,
  isFileExists,
  isFolderExists,
  loadFileData,
  removeFolder,
  tryToFindFileRecursively,
} from './file_utils.js';
import {AdkLogger} from './logger.js';

const logger = new AdkLogger({label: 'AgentLoader', colorize: {all: true}});

/**
 * Supported file extensions for JavaScript and TypeScript.
 */
const JS_FILES_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts'];

/**
 * Basenames that can never be an agent entrypoint: dotfiles, TypeScript
 * declaration files, and test/spec files.
 */
const NON_ENTRYPOINT_FILE_PATTERN =
  /^\.|\.d\.[cm]?ts$|\.(test|spec)\.[cm]?[jt]s$/;

/** Directory names never scanned for an agent entrypoint. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build']);

/**
 * Supported JS/TS file module types.
 */
export enum FileModuleType {
  CJS = 'cjs',
  ESM = 'esm',
}

/**
 * Map of file module types to their file extensions.
 */
const FILE_MODULE_TYPE_EXTENSION_MAP = {
  [FileModuleType.CJS]: '.cjs',
  [FileModuleType.ESM]: '.mjs',
};

/**
 * Metadata for a file.
 */
export interface FileMetadata {
  path: string;
  name: string;
  ext?: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * Error class for agent file loading.
 *
 * Thrown when a file is not a usable agent entrypoint — it does not exist, or
 * it is a valid module that exports no `BaseAgent`/`App`. Every other failure
 * (a compile error, a permission error, a module that throws at import time)
 * is reported with its own error type.
 */
export class AgentFileLoadingError extends Error {}

/**
 * Options for loading an agent file.
 */
export interface AgentFileOptions {
  compile?: boolean;
  bundle?: boolean;
  moduleType?: FileModuleType;
}

/**
 * Default options for loading an agent file.
 *
 * Compile and bundle only .ts files.
 */
const DEFAULT_AGENT_FILE_OPTIONS: AgentFileOptions = {
  compile: true,
  bundle: true,
};

/**
 * Returns an esbuild plugin that replaces `__dirname`, `__filename`, and `import.meta.url`
 * with the original directory path, file path, and file URL in the agent file.
 * This plugin is needed to ensure that the agent file has access to its original
 * location context after compilation.
 *
 * @param filePath - The path to the agent file.
 * @param originalDir - The original directory path of the agent file.
 * @returns An esbuild plugin that replaces path and URL references in the agent file.
 */
export function replaceDirnamePlugin(filePath: string, originalDir: string) {
  return {
    name: 'replace-dirname',
    setup(build: esbuild.PluginBuild) {
      build.onLoad({filter: /.*/}, async (args: esbuild.OnLoadArgs) => {
        if (args.path === filePath) {
          const content = await fsPromises.readFile(args.path, 'utf8');
          const fileUrl = pathToFileURL(filePath).href;
          const loader = ['.ts', '.mts', '.cts'].includes(
            path.extname(filePath),
          )
            ? 'ts'
            : 'js';
          const transformResult = await esbuild.transform(content, {
            loader: loader,
            define: {
              '__dirname': JSON.stringify(originalDir),
              '__filename': JSON.stringify(filePath),
              'import.meta.url': JSON.stringify(fileUrl),
            },
          });

          return {
            contents: transformResult.code,
            loader: 'js',
          };
        }
        return undefined;
      });
    },
  };
}

/**
 * Wrapper class which loads file that contains base agent or app (support both .js and
 * .ts) and has a dispose function to cleanup the compiled artifact after file
 * usage.
 */
export class AgentFile {
  private cleanupFilePath: string | undefined;
  private cleanupDirPath: string | undefined;
  private disposed = false;
  private agent?: BaseAgent;
  private app?: App;
  private loadPromise?: Promise<BaseAgent | App>;

  constructor(
    private readonly filePath: string,
    private readonly options = DEFAULT_AGENT_FILE_OPTIONS,
  ) {}

  /**
   * Compiles and imports the agent file, at most once.
   *
   * Concurrent callers share a single compile + import; a rejected load clears
   * the memo so a transient failure stays retryable.
   */
  async load(): Promise<BaseAgent | App> {
    if (this.app) {
      return this.app;
    }
    if (this.agent) {
      return this.agent;
    }

    this.loadPromise ??= this.loadUncached().catch((e: unknown) => {
      this.loadPromise = undefined;
      throw e;
    });

    return this.loadPromise;
  }

  private async loadUncached(): Promise<BaseAgent | App> {
    try {
      await fsPromises.stat(this.filePath);
    } catch (e) {
      if ((e as {code: string}).code === 'ENOENT') {
        throw new AgentFileLoadingError(
          `Agent file ${this.filePath} does not exists`,
        );
      }
    }

    let filePath = this.filePath;
    const shouldCompile = this.options.compile || this.options.bundle;

    if (shouldCompile) {
      const moduleType =
        this.options.moduleType || (await getFileModuleType(filePath));
      const parsedPath = path.parse(filePath);
      const outputDir = getTempDir('adk_agent_loader');
      const compiledFilePath = path.join(
        outputDir,
        parsedPath.name + FILE_MODULE_TYPE_EXTENSION_MAP[moduleType],
      );
      const originalDir = path.dirname(filePath);
      await fsPromises.mkdir(outputDir, {recursive: true});
      await linkProjectNodeModules(outputDir, parsedPath.dir);

      await esbuild.build({
        entryPoints: [filePath],
        outfile: compiledFilePath,
        target: 'node16',
        platform: 'node',
        format: moduleType,
        packages: 'bundle',
        bundle: this.options.bundle,
        minify: this.options.bundle,
        allowOverwrite: true,
        plugins: [replaceDirnamePlugin(filePath, originalDir), shimPlugin()],
        // See http://mikro-orm.io/docs/deployment#deploy-a-bundle-of-entities-and-dependencies-with-esbuild for more details
        external: [
          'sqlite3',
          'better-sqlite3',
          'mysql',
          'mysql2',
          // Native addons must remain external so Node can resolve their
          // platform-specific assets at runtime.
          'onnxruntime-node',
          'oracledb',
          'pg-native',
          'pg-query-stream',
          'tedious',
          'libsql',
          // Optional peer dependencies of vite and eslint that are not
          // installed and MUST NOT be bundled.
          'lightningcss',
          'jiti',
          'jiti/package.json',
        ],
      });

      this.cleanupDirPath = outputDir;
      this.cleanupFilePath = compiledFilePath;
      filePath = compiledFilePath;
    }

    const require = createRequire(import.meta.url);
    try {
      delete require.cache[require.resolve(filePath)];
    } catch {
      logger.warn(`Failed to delete require cache for ${filePath}`);
    }

    const importUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const jsModule = await import(importUrl);

    if (jsModule) {
      if (isApp(jsModule.app)) {
        this.app = jsModule.app;
        this.agent = jsModule.app.rootAgent;
        return this.app!;
      }

      if (isApp(jsModule.rootApp)) {
        this.app = jsModule.rootApp;
        this.agent = jsModule.rootApp.rootAgent;
        return this.app!;
      }

      const defaultApp = [jsModule.default, jsModule.default?.default].find(
        isApp,
      );
      if (defaultApp) {
        this.app = defaultApp;
        this.agent = defaultApp.rootAgent;
        return this.app!;
      }

      const rootApps = Object.values(jsModule).filter(isApp) as App[];

      if (rootApps.length > 1) {
        console.warn(
          `Multiple apps found in ${filePath}. Using the ${rootApps[0].name} as a root app.`,
        );
      }

      if (rootApps.length > 0) {
        this.app = rootApps[0];
        this.agent = rootApps[0].rootAgent;
        return this.app!;
      }

      if (isBaseAgent(jsModule.rootAgent)) {
        return (this.agent = jsModule.rootAgent);
      }

      const defaultAgent = [jsModule.default, jsModule.default?.default].find(
        isBaseAgent,
      );
      if (defaultAgent) {
        return (this.agent = defaultAgent);
      }

      const rootAgents = Object.values(jsModule).filter(
        isBaseAgent,
      ) as BaseAgent[];

      if (rootAgents.length > 1) {
        console.warn(
          `Multiple agents found in ${filePath}. Using the ${rootAgents[0].name} as a root agent.`,
        );
      }

      if (rootAgents.length > 0) {
        return (this.agent = rootAgents[0]);
      }
    }

    await this.dispose();
    throw new AgentFileLoadingError(
      `Failed to load agent ${
        filePath
      }: No @google/adk BaseAgent class instance found. Please check that file is not empty and it has export of @google/adk BaseAgent class (e.g. LlmAgent) instance.`,
    );
  }

  async loadAgent(): Promise<BaseAgent> {
    await this.load();
    return this.agent!;
  }

  async loadApp(): Promise<App> {
    const loaded = await this.load();
    if (isApp(loaded)) {
      return loaded;
    }
    if (!this.app && this.agent) {
      this.app = new App({
        name: this.agent.name,
        rootAgent: this.agent,
      });
    }
    return this.app!;
  }

  getFilePath(): string {
    if (!this.agent && !this.app) {
      throw new Error('Agent is not loaded yet');
    }

    if (this.disposed) {
      throw new Error('Agent is disposed and can not be used');
    }

    return this.cleanupFilePath || this.filePath;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.cleanupFilePath) {
      this.disposed = true;
      await fsPromises.unlink(this.cleanupFilePath);
      if (this.cleanupDirPath) {
        await removeFolder(this.cleanupDirPath);
      }
    }
  }
}

/**
 * Loads all agents/apps from a given directory.
 *
 * The directory structure should be:
 * - agents_dir/{agentOrAppName}.[js | ts | mjs | cjs]
 * - agents_dir/{agentOrAppName}/agent.[js | ts | mjs | cjs]
 * - agents_dir/{agentOrAppName}/app.[js | ts | mjs | cjs]
 *
 * Agent/App file should have export of the rootAgent as instance of BaseAgent or
 * app/rootApp as instance of App.
 */
export class AgentLoader {
  private discoveryPromise?: Promise<void>;
  private readonly discoveredAgents: Record<string, AgentFile> = {};
  private watcher?: fs.FSWatcher;

  constructor(
    private readonly agentsDirPath: string = process.cwd(),
    private readonly options = DEFAULT_AGENT_FILE_OPTIONS,
    private readonly watchForChanges = false,
  ) {
    // Do cleanups on exit
    const exitHandler = async ({
      exit,
      cleanup,
    }: {
      exit?: boolean;
      cleanup?: boolean;
    }) => {
      if (cleanup) {
        await this.disposeAll();
      }

      if (exit) {
        process.exit();
      }
    };

    process.on('exit', () => exitHandler({cleanup: true}));
    process.on('SIGINT', () => exitHandler({exit: true}));
    process.on('SIGUSR1', () => exitHandler({exit: true}));
    process.on('SIGUSR2', () => exitHandler({exit: true}));
    process.on('uncaughtException', () => exitHandler({exit: true}));
  }

  /**
   * Starts watching the agents directory for file changes. When a change is
   * detected all cached agents are invalidated so they are reloaded on the
   * next request.
   */
  private startWatching(): void {
    if (this.watcher) {
      return;
    }

    try {
      this.watcher = fs.watch(
        this.agentsDirPath,
        {recursive: true},
        (_event, filename) => {
          if (filename && isJsFile(path.extname(filename))) {
            logger.info(`Detected change in ${filename}, reloading agents...`);
            this.invalidateAll();
          }
        },
      );

      this.watcher.on('error', (err) => {
        logger.warn('File watcher error:', err.message);
      });
    } catch (err) {
      logger.warn('Could not start file watcher:', (err as Error).message);
    }
  }

  /**
   * Disposes all cached agents and marks them for reload on the next request.
   */
  private invalidateAll(): void {
    for (const agentFile of Object.values(this.discoveredAgents)) {
      agentFile.dispose().catch(() => {});
    }

    for (const key of Object.keys(this.discoveredAgents)) {
      delete this.discoveredAgents[key];
    }

    this.discoveryPromise = undefined;
  }

  async listAgents(): Promise<string[]> {
    await this.discoverAgents();

    return Object.keys(this.discoveredAgents).sort();
  }

  async listApps(): Promise<string[]> {
    await this.discoverAgents();

    // Candidates are loaded concurrently: this is the one call that still has
    // to compile and import everything, so serializing it would make it cost
    // the sum of every agent's load rather than the slowest one.
    const appNames = await Promise.all(
      Object.entries(this.discoveredAgents).map(async ([name, agentFile]) =>
        isApp(await tryLoadAgentFile(agentFile)) ? name : undefined,
      ),
    );

    return appNames.filter((name) => name !== undefined).sort();
  }

  /**
   * Returns the handle for a discovered agent.
   *
   * The handle is **not** loaded: callers that need the agent instance or the
   * compiled artifact path must `await agentFile.load()` first.
   */
  async getAgentFile(agentName: string): Promise<AgentFile> {
    await this.discoverAgents();

    return this.discoveredAgents[agentName];
  }

  async getAppFile(appName: string): Promise<AgentFile> {
    return this.getAgentFile(appName);
  }

  async disposeAll(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    await Promise.all(
      Object.values(this.discoveredAgents).map((f) => f.dispose()),
    );
  }

  /**
   * Scans the agents directory and registers one unloaded {@link AgentFile}
   * handle per candidate, at most once.
   *
   * Discovery never compiles and never imports; that cost is deferred to
   * {@link AgentFile.load}. Concurrent callers share a single scan, and a
   * rejected scan clears the memo so it stays retryable.
   */
  async discoverAgents(): Promise<void> {
    this.discoveryPromise ??= this.scanAgentsDir().catch((e: unknown) => {
      this.discoveryPromise = undefined;
      throw e;
    });

    return this.discoveryPromise;
  }

  private async scanAgentsDir(): Promise<void> {
    if (await isFile(this.agentsDirPath)) {
      // The structural filters apply to entries found by scanning a directory,
      // never to a file the caller named explicitly.
      this.registerAgentFromFile(await getFileMetadata(this.agentsDirPath));
    } else {
      const entries = await getDirFiles(this.agentsDirPath);

      await Promise.all(
        entries.map(async (entry: FileMetadata) => {
          if (isAgentEntrypointFile(entry)) {
            this.registerAgentFromFile(entry);
          } else if (isScannableDirectory(entry)) {
            await this.registerAgentFromDirectory(entry);
          }
        }),
      );
    }

    if (this.watchForChanges) {
      this.startWatching();
    }
  }

  private registerAgentFromFile(file: FileMetadata): void {
    this.discoveredAgents[file.name] = new AgentFile(file.path, this.options);
  }

  private async registerAgentFromDirectory(dir: FileMetadata): Promise<void> {
    const subFiles = await getDirFiles(dir.path);
    const possibleEntryFile =
      subFiles.find((f) => f.isFile && f.name === 'app' && isJsFile(f.ext)) ??
      subFiles.find((f) => f.isFile && f.name === 'agent' && isJsFile(f.ext));

    if (!possibleEntryFile) {
      return;
    }

    this.discoveredAgents[dir.name] = new AgentFile(
      possibleEntryFile.path,
      this.options,
    );
  }
}

/**
 * Loads an agent file, returning `undefined` when the file is not a valid
 * agent entrypoint. Any other failure — a compile error, for instance —
 * propagates to the caller.
 */
export async function tryLoadAgentFile(
  agentFile: AgentFile,
): Promise<BaseAgent | App | undefined> {
  try {
    return await agentFile.load();
  } catch (e: unknown) {
    if (e instanceof AgentFileLoadingError) {
      return undefined;
    }
    throw e;
  }
}

/**
 * Returns whether a scanned directory entry can be an agent entrypoint file.
 *
 * Dotfiles, TypeScript declaration files and test/spec files share the agent
 * extensions but can never export an agent.
 */
export function isAgentEntrypointFile(file: FileMetadata): boolean {
  return (
    file.isFile &&
    isJsFile(file.ext) &&
    !NON_ENTRYPOINT_FILE_PATTERN.test(path.basename(file.path))
  );
}

/**
 * Returns whether a scanned directory entry should be searched for an agent
 * entrypoint.
 *
 * Mirrors `adk-python`'s rule of skipping dot-directories, plus the tooling
 * directories that never hold a developer's agent.
 */
export function isScannableDirectory(dir: FileMetadata): boolean {
  return (
    dir.isDirectory &&
    !dir.name.startsWith('.') &&
    !SKIPPED_DIRECTORIES.has(dir.name)
  );
}

function isJsFile(fileExt?: string): boolean {
  return !!fileExt && JS_FILES_EXTENSIONS.includes(fileExt);
}

async function getDirFiles(dir: string): Promise<FileMetadata[]> {
  const files = await fsPromises.readdir(dir);

  return await Promise.all(
    files.map((filePath) => getFileMetadata(path.join(dir, filePath))),
  );
}

async function getFileMetadata(filePath: string): Promise<FileMetadata> {
  const fileStats = await fsPromises.stat(filePath);
  const isFile = fileStats.isFile();
  const baseName = path.basename(filePath);
  const ext = path.extname(filePath);

  return {
    path: filePath,
    name: isFile ? baseName.slice(0, baseName.length - ext.length) : baseName,
    ext: isFile ? path.extname(filePath) : undefined,
    isFile,
    isDirectory: fileStats.isDirectory(),
  };
}

async function getFileModuleType(filePath: string): Promise<FileModuleType> {
  const {ext} = path.parse(filePath);

  if (['.cjs', '.cts'].includes(ext)) {
    return FileModuleType.CJS;
  }
  if (['.mts', '.mjs'].includes(ext)) {
    return FileModuleType.ESM;
  }

  if (['.js', '.ts'].includes(ext)) {
    return getTypeFromPackageJson(path.dirname(filePath));
  }

  return FileModuleType.CJS;
}

async function getTypeFromPackageJson(dir: string): Promise<FileModuleType> {
  const packagePath = path.join(dir, 'package.json');

  if (await isFileExists(packagePath)) {
    try {
      const packageJson = (await loadFileData(packagePath)) as {
        type?: 'commonjs' | 'module';
      };

      return packageJson.type === 'module'
        ? FileModuleType.ESM
        : FileModuleType.CJS;
    } catch {
      return FileModuleType.CJS;
    }
  }

  const parentDir = path.dirname(dir);
  if (parentDir === dir) {
    return FileModuleType.CJS;
  }

  return getTypeFromPackageJson(parentDir);
}

async function linkProjectNodeModules(
  outputDir: string,
  sourceDir: string,
): Promise<void> {
  const nodeModulesDir = await getProjectNodeModulesDir(sourceDir);
  if (!nodeModulesDir) {
    return;
  }

  const linkPath = path.join(outputDir, 'node_modules');
  if (await isFolderExists(linkPath)) {
    return;
  }

  try {
    await fsPromises.symlink(
      path.resolve(nodeModulesDir),
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if ((error as {code?: string}).code !== 'EEXIST') {
      throw error;
    }
  }
}

async function getProjectNodeModulesDir(
  sourceDir: string,
): Promise<string | undefined> {
  try {
    const packageJsonPath = await tryToFindFileRecursively(
      sourceDir,
      'package.json',
      10,
    );
    const nodeModulesDir = path.join(
      path.dirname(packageJsonPath),
      'node_modules',
    );

    return (await isFolderExists(nodeModulesDir)) ? nodeModulesDir : undefined;
  } catch {
    return undefined;
  }
}
