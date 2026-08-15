/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {RunnableRoot} from '@google/adk';
import {App, isApp, isRunnableRoot} from '@google/adk';
import esbuild from 'esbuild';
import {shimPlugin} from 'esbuild-shim-plugin';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

import {
  createTempDir,
  isFile,
  isFileExists,
  isFolderExists,
  loadFileData,
  removeFolder,
  tryToFindFolderRecursively,
} from './file_utils.js';
import {AdkLogger} from './logger.js';

const logger = new AdkLogger({label: 'AgentLoader', colorize: {all: true}});

/**
 * Maps a supported JavaScript/TypeScript extension to the esbuild loader that
 * parses it.
 */
const FILE_EXTENSION_LOADER_MAP: Readonly<Record<string, esbuild.Loader>> = {
  '.js': 'js',
  '.cjs': 'js',
  '.mjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
};

/**
 * Supported file extensions for JavaScript and TypeScript.
 */
// Not derived from FILE_EXTENSION_LOADER_MAP: .jsx/.tsx must never become
// discoverable agent files.
const JS_FILES_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts'];

/**
 * How many ancestor directories to search for a project's `node_modules`.
 */
const MAX_NODE_MODULES_LOOKUP_LEVELS = 10;

/**
 * Matches the location tokens that {@link replaceDirnamePlugin} rewrites. A
 * module without any of them keeps esbuild's own loading path.
 */
const LOCATION_TOKEN_PATTERN = /import\.meta|__dirname|__filename/;

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
interface FileMetadata {
  path: string;
  name: string;
  ext?: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * Signals "this file is not an agent file" (missing, empty, or exporting no
 * agent), which is normal in a directory that also holds helper modules, so it
 * is skipped rather than recorded as a failure; the skip is logged at debug
 * level. Any OTHER error means the file *is* an agent that failed to
 * construct — see {@link AgentLoadFailure}.
 */
class AgentFileLoadingError extends Error {}

/**
 * Raised when the loader never discovered an app of this name in the agents
 * directory, as opposed to an agent it found and could not load. Callers use
 * this to answer "no such app" (404) rather than "the app is broken" (500).
 */
export class AgentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentNotFoundError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, AgentNotFoundError.prototype);
  }
}

/**
 * Type guard for {@link AgentNotFoundError}.
 *
 * Matches on `name` rather than `instanceof` so it stays correct when two
 * copies of adk-js share one runtime.
 */
export function isAgentNotFoundError(e: unknown): e is AgentNotFoundError {
  return e instanceof Error && e.name === 'AgentNotFoundError';
}

/**
 * An agent that could not be loaded. Recorded rather than thrown, so one broken
 * agent cannot take the whole server down with it.
 */
export interface AgentLoadFailure {
  /** The app name the broken file would have been served under. */
  name: string;
  filePath: string;
  error: Error;
}

/**
 * Options for loading an agent file.
 *
 * Omitted fields fall back to the compile/bundle defaults; a field passed
 * explicitly as `undefined` does not (plain spread merge).
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
 * Returns an esbuild plugin that replaces `__dirname`, `__filename`,
 * `import.meta.url`, `import.meta.dirname` and `import.meta.filename` with the
 * location of the module that reads them. Every module in the bundle keeps its
 * own source location, so a bundled dependency that reads a file next to
 * itself still finds it after the agent is compiled into a temp directory.
 *
 * @returns An esbuild plugin that replaces path and URL references in the bundle.
 */
export function replaceDirnamePlugin() {
  return {
    name: 'replace-dirname',
    setup(build: Pick<esbuild.PluginBuild, 'onLoad'>) {
      // Only the `file` namespace: a path owned by another plugin is virtual
      // and has nothing to read on disk.
      build.onLoad(
        {filter: /.*/, namespace: 'file'},
        async (args: esbuild.OnLoadArgs) => {
          const loader = FILE_EXTENSION_LOADER_MAP[path.extname(args.path)];
          if (!loader) {
            return undefined;
          }

          const content = await fsPromises.readFile(args.path, 'utf8');
          if (!LOCATION_TOKEN_PATTERN.test(content)) {
            return undefined;
          }

          const moduleDir = path.dirname(args.path);
          const transformResult = await esbuild.transform(content, {
            loader,
            // Without it esbuild reports a syntax error against `<stdin>`
            // instead of the module it came from.
            sourcefile: args.path,
            // Leave the JSX to the outer build, which reads the project's
            // tsconfig. Compiling it here would apply esbuild's own defaults
            // and break the automatic JSX runtime.
            jsx: 'preserve',
            define: {
              '__dirname': JSON.stringify(moduleDir),
              '__filename': JSON.stringify(args.path),
              'import.meta.url': JSON.stringify(pathToFileURL(args.path).href),
              'import.meta.dirname': JSON.stringify(moduleDir),
              'import.meta.filename': JSON.stringify(args.path),
            },
          });

          return {
            contents: transformResult.code,
            loader: loader === 'jsx' || loader === 'tsx' ? 'jsx' : 'js',
          };
        },
      );
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
  private agent?: RunnableRoot;
  private app?: App;
  private readonly options: AgentFileOptions;

  constructor(
    private readonly filePath: string,
    options: AgentFileOptions = {},
  ) {
    this.options = {...DEFAULT_AGENT_FILE_OPTIONS, ...options};
  }

  async load(): Promise<RunnableRoot | App> {
    if (this.app) {
      return this.app;
    }
    if (this.agent) {
      return this.agent;
    }

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
      const outputDir = await createTempDir('adk_agent_loader');
      // Recorded before anything can throw, so a failed compile or import
      // still leaves dispose() able to remove the directory.
      this.cleanupDirPath = outputDir;
      const compiledFilePath = path.join(
        outputDir,
        parsedPath.name + FILE_MODULE_TYPE_EXTENSION_MAP[moduleType],
      );
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
        plugins: [replaceDirnamePlugin(), shimPlugin()],
        // See http://mikro-orm.io/docs/deployment#deploy-a-bundle-of-entities-and-dependencies-with-esbuild for more details
        external: [
          // Resolve the ADK runtime from the project's node_modules (see
          // linkProjectNodeModules) instead of embedding a copy per agent, so a
          // directory of N agents loads one shared ADK rather than N of them.
          '@google/adk',
          '@google/adk-devtools',
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
        logger.warn(
          `Multiple apps found in ${filePath}. Using the ${rootApps[0].name} as a root app.`,
        );
      }

      if (rootApps.length > 0) {
        this.app = rootApps[0];
        this.agent = rootApps[0].rootAgent;
        return this.app!;
      }

      // A bare `Workflow` counts as a root: the runner drives it as a node, so
      // a sample can export a graph directly rather than dressing it as an
      // agent.
      if (isRunnableRoot(jsModule.rootAgent)) {
        return (this.agent = jsModule.rootAgent);
      }

      const defaultAgent = [jsModule.default, jsModule.default?.default].find(
        isRunnableRoot,
      );
      if (defaultAgent) {
        return (this.agent = defaultAgent);
      }

      const rootAgents = Object.values(jsModule).filter(isRunnableRoot);

      if (rootAgents.length > 1) {
        logger.warn(
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
      }: No @google/adk BaseAgent or Workflow instance found. Please check that file is not empty and it exports an @google/adk BaseAgent (e.g. LlmAgent) or Workflow instance.`,
    );
  }

  async loadAgent(): Promise<RunnableRoot> {
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
    this.disposed = true;

    // The compiled artifact lives inside this directory, so removing the
    // directory removes it too. removeFolder reports its own failures instead
    // of throwing, which keeps dispose() safe for the fire-and-forget callers.
    if (this.cleanupDirPath) {
      await removeFolder(this.cleanupDirPath);
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
 * Agent/App file should have export of the rootAgent as instance of BaseAgent
 * (or a Workflow, which is adapted into one) or app/rootApp as instance of App.
 */
export class AgentLoader {
  private agentsAlreadyPreloaded = false;
  private preloadInFlight?: Promise<void>;
  private readonly preloadedAgents: Record<string, AgentFile> = {};
  private readonly loadFailures: Record<string, AgentLoadFailure> = {};
  private watcher?: fs.FSWatcher;

  constructor(
    private readonly agentsDirPath: string = process.cwd(),
    // Defaulted per field by the AgentFile these are forwarded to.
    private readonly options: AgentFileOptions = {},
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
    for (const agentFile of Object.values(this.preloadedAgents)) {
      agentFile.dispose().catch(() => {});
    }

    for (const key of Object.keys(this.preloadedAgents)) {
      delete this.preloadedAgents[key];
    }

    for (const key of Object.keys(this.loadFailures)) {
      delete this.loadFailures[key];
    }

    this.agentsAlreadyPreloaded = false;
    // Detach any running scan so the invalidation is not swallowed by a
    // caller joining results that were gathered before the change.
    this.preloadInFlight = undefined;
  }

  /**
   * The agents that failed to load. They are excluded from {@link listAgents},
   * and {@link getAgentFile} rethrows the original error for one by name.
   */
  async listLoadFailures(): Promise<AgentLoadFailure[]> {
    await this.preloadAgents();

    return Object.values(this.loadFailures).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async listAgents(): Promise<string[]> {
    await this.preloadAgents();

    return Object.keys(this.preloadedAgents).sort();
  }

  async listApps(): Promise<string[]> {
    await this.preloadAgents();

    const appNames: string[] = [];
    for (const [name, agentFile] of Object.entries(this.preloadedAgents)) {
      try {
        const loaded = await agentFile.load();
        if (isApp(loaded)) {
          appNames.push(name);
        }
      } catch {
        // Ignore loading errors when listing apps
      }
    }

    return appNames.sort();
  }

  /**
   * Lends the caller the `AgentFile` this loader owns for `agentName`.
   *
   * Every caller shares the handle, and only `invalidateAll()` or
   * `disposeAll()` ends its life. A caller must not dispose it: disposal
   * deletes the compiled artifact that the other callers still read.
   */
  async getAgentFile(agentName: string): Promise<AgentFile> {
    await this.preloadAgents();

    const agentFile = this.preloadedAgents[agentName];
    if (agentFile) {
      return agentFile;
    }

    // Report the real reason rather than returning undefined and letting the
    // caller fail later with "cannot read properties of undefined".
    const failure = this.loadFailures[agentName];
    if (failure) {
      throw new Error(
        `Agent '${agentName}' failed to load from ${failure.filePath}: ${failure.error.message}`,
        {cause: failure.error},
      );
    }

    throw new AgentNotFoundError(
      `Agent '${agentName}' not found in ${this.agentsDirPath}. ` +
        `Available agents: ${Object.keys(this.preloadedAgents).sort().join(', ') || '(none)'}`,
    );
  }

  async getAppFile(appName: string): Promise<AgentFile> {
    return this.getAgentFile(appName);
  }

  async disposeAll(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    await Promise.all(
      Object.values(this.preloadedAgents).map((f) => f.dispose()),
    );
  }

  /**
   * Discovers, compiles and imports every agent in the agents directory.
   *
   * Callers that arrive while a scan is running join it. A rejected scan is
   * discarded, so a later call retries from scratch.
   */
  async preloadAgents(): Promise<void> {
    if (this.agentsAlreadyPreloaded) {
      return;
    }

    // A second concurrent scan re-bundles and re-imports every entrypoint, and
    // its AgentFile instances overwrite the first scan's in `preloadedAgents`,
    // so the displaced ones are never disposed and their temp directories leak.
    this.preloadInFlight ??= this.scanAgents().catch((e: unknown) => {
      this.preloadInFlight = undefined;
      throw e;
    });

    return this.preloadInFlight;
  }

  private async scanAgents(): Promise<void> {
    const files = (await isFile(this.agentsDirPath))
      ? [await getFileMetadata(this.agentsDirPath)]
      : await getDirFiles(this.agentsDirPath);

    await Promise.all(
      files.map(async (fileOrDir: FileMetadata) => {
        if (fileOrDir.isFile && isJsFile(fileOrDir.ext)) {
          return this.loadAgentFromFile(fileOrDir);
        }

        if (fileOrDir.isDirectory) {
          if (
            fileOrDir.name === 'node_modules' ||
            fileOrDir.name.startsWith('.')
          ) {
            return;
          }
          return this.loadAgentFromDirectory(fileOrDir);
        }
      }),
    );

    this.agentsAlreadyPreloaded = true;

    if (this.watchForChanges && !this.watcher) {
      this.startWatching();
    }

    return;
  }

  private async loadAgentFromFile(file: FileMetadata): Promise<void> {
    const agentFile = new AgentFile(file.path, this.options);
    try {
      await agentFile.load();
      this.preloadedAgents[file.name] = agentFile;
    } catch (e) {
      await agentFile.dispose();
      this.recordLoadFailure(file.name, file.path, e);
    }
  }

  private async loadAgentFromDirectory(dir: FileMetadata): Promise<void> {
    const subFiles = await getDirFiles(dir.path);
    const possibleEntryFile =
      subFiles.find((f) => f.isFile && f.name === 'app' && isJsFile(f.ext)) ??
      subFiles.find((f) => f.isFile && f.name === 'agent' && isJsFile(f.ext));

    if (!possibleEntryFile) {
      return;
    }

    const agentFile = new AgentFile(possibleEntryFile.path, this.options);
    try {
      await agentFile.load();
      this.preloadedAgents[dir.name] = agentFile;
    } catch (e) {
      await agentFile.dispose();
      this.recordLoadFailure(dir.name, possibleEntryFile.path, e);
    }
  }

  /**
   * Propagating here would reject the `Promise.all` in `preloadAgents`, failing
   * every endpoint that lists or resolves agents — so record instead of throw.
   */
  private recordLoadFailure(name: string, filePath: string, e: unknown): void {
    if (e instanceof AgentFileLoadingError) {
      // The source path is in the message because the error names the compiled
      // artifact instead.
      logger.debug(`Skipped ${filePath}: ${e.message}`);
      return;
    }

    const error = e instanceof Error ? e : new Error(String(e));
    this.loadFailures[name] = {name, filePath, error};
    logger.error(
      `Failed to load agent '${name}' from ${filePath}: ${error.message}. ` +
        `Skipping it; the other agents are unaffected.`,
    );
  }
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

/**
 * Find the `node_modules` a bundled agent should resolve its externals from.
 *
 * Mirrors Node's own upward `node_modules` walk, so a project whose own
 * directory has a `package.json` but no `node_modules` — the npm/pnpm
 * workspace layout, where dependencies are hoisted to the workspace root —
 * still resolves. Returns `undefined` when nothing is found within the bound.
 */
async function getProjectNodeModulesDir(
  sourceDir: string,
): Promise<string | undefined> {
  try {
    return await tryToFindFolderRecursively(
      sourceDir,
      'node_modules',
      MAX_NODE_MODULES_LOOKUP_LEVELS,
    );
  } catch {
    return undefined;
  }
}
