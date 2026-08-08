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
  createTempDir,
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
 * File extensions that esbuild must read with its TypeScript loader.
 */
const TS_FILES_EXTENSIONS = ['.ts', '.mts', '.cts'];

/**
 * Name prefix of the private temp directory that owns one compiled agent.
 */
const AGENT_OUTPUT_DIR_PREFIX = 'adk_agent_loader';

/**
 * Name prefix of the scratch directory esbuild writes a batch into.
 */
const BUILD_SCRATCH_DIR_PREFIX = 'adk_agent_loader_build';

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
 * Packages esbuild must not bundle into a compiled agent.
 *
 * See http://mikro-orm.io/docs/deployment#deploy-a-bundle-of-entities-and-dependencies-with-esbuild for more details
 */
const EXTERNAL_PACKAGES = [
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
];

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

/** A compiled agent entrypoint together with the temp dir that owns it. */
interface CompiledEntrypoint {
  outputDir: string;
  compiledFilePath: string;
}

/** A discovered agent entrypoint: the name it is registered under and its file. */
interface DiscoveredEntrypoint {
  name: string;
  filePath: string;
}

/** An entrypoint with everything the batched build needs to emit it. */
interface PreparedEntrypoint extends CompiledEntrypoint {
  filePath: string;
  moduleType: FileModuleType;
  outName: string;
}

/**
 * Error class for agent file loading.
 */
class AgentFileLoadingError extends Error {}

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
 * A single build can carry several agent entrypoints, so the plugin looks the
 * directory up per file instead of closing over one entrypoint.
 *
 * @param entryDirs - Maps each entrypoint path to its original directory path.
 * @returns An esbuild plugin that replaces path and URL references in the agent file.
 */
export function replaceDirnamePlugin(entryDirs: ReadonlyMap<string, string>) {
  return {
    name: 'replace-dirname',
    setup(build: esbuild.PluginBuild) {
      build.onLoad({filter: /.*/}, async (args: esbuild.OnLoadArgs) => {
        const originalDir = entryDirs.get(args.path);
        if (originalDir === undefined) {
          return undefined;
        }

        const content = await fsPromises.readFile(args.path, 'utf8');
        const loader = TS_FILES_EXTENSIONS.includes(path.extname(args.path))
          ? 'ts'
          : 'js';
        const transformResult = await esbuild.transform(content, {
          loader,
          // Without a source file name esbuild reports a syntax error in an
          // entrypoint as `<stdin>`, which names no file in a batched build.
          sourcefile: args.path,
          define: {
            '__dirname': JSON.stringify(originalDir),
            '__filename': JSON.stringify(args.path),
            'import.meta.url': JSON.stringify(pathToFileURL(args.path).href),
          },
        });

        return {
          contents: transformResult.code,
          loader: 'js',
        };
      });
    },
  };
}

/**
 * Compiles every given entrypoint, using one esbuild build per module format.
 *
 * Each entrypoint keeps its own private temp directory, so the batching is not
 * observable in the emitted artifacts. A build writes into a shared scratch
 * directory first, because esbuild needs one `outdir` per build.
 *
 * @param filePaths - Absolute paths of the entry files to compile.
 * @param options - Loader-wide compilation options shared by every entry.
 * @returns The compiled artifact for each entry, keyed by input file path.
 */
async function compileEntrypoints(
  filePaths: readonly string[],
  options: AgentFileOptions,
): Promise<Map<string, CompiledEntrypoint>> {
  const prepared: PreparedEntrypoint[] = await Promise.all(
    filePaths.map(async (filePath, index) => {
      const moduleType =
        options.moduleType || (await getFileModuleType(filePath));
      const parsedPath = path.parse(filePath);
      const outputDir = await createTempDir(AGENT_OUTPUT_DIR_PREFIX);
      await linkProjectNodeModules(outputDir, parsedPath.dir);

      return {
        filePath,
        moduleType,
        outputDir,
        outName: `entry_${index}`,
        compiledFilePath: path.join(
          outputDir,
          parsedPath.name + FILE_MODULE_TYPE_EXTENSION_MAP[moduleType],
        ),
      };
    }),
  );

  const buildDir = await createTempDir(BUILD_SCRATCH_DIR_PREFIX);
  try {
    await Promise.all(
      groupByModuleType(prepared).map((group) =>
        buildGroup(group, buildDir, options),
      ),
    );
  } catch (e) {
    await Promise.all(prepared.map((entry) => removeFolder(entry.outputDir)));
    throw e;
  } finally {
    await removeFolder(buildDir);
  }

  return new Map(
    prepared.map((entry) => [
      entry.filePath,
      {outputDir: entry.outputDir, compiledFilePath: entry.compiledFilePath},
    ]),
  );
}

/**
 * Splits entrypoints into one group per module type.
 *
 * A single esbuild build emits a single output format, so CJS and ESM
 * entrypoints cannot share one build.
 */
function groupByModuleType(
  entries: readonly PreparedEntrypoint[],
): PreparedEntrypoint[][] {
  const groups = new Map<FileModuleType, PreparedEntrypoint[]>();
  for (const entry of entries) {
    const group = groups.get(entry.moduleType);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.moduleType, [entry]);
    }
  }

  return [...groups.values()];
}

/**
 * Compiles one same-module-type group in a single esbuild build, then moves
 * each output from the shared scratch directory into that entry's own temp dir.
 */
async function buildGroup(
  group: readonly PreparedEntrypoint[],
  buildDir: string,
  options: AgentFileOptions,
): Promise<void> {
  const moduleType = group[0].moduleType;
  const outExtension = FILE_MODULE_TYPE_EXTENSION_MAP[moduleType];

  await esbuild.build({
    entryPoints: group.map((entry) => ({
      in: entry.filePath,
      out: entry.outName,
    })),
    outdir: buildDir,
    outExtension: {'.js': outExtension},
    target: 'node16',
    platform: 'node',
    format: moduleType,
    packages: 'bundle',
    bundle: options.bundle,
    minify: options.bundle,
    plugins: [
      replaceDirnamePlugin(
        new Map(
          group.map((entry) => [entry.filePath, path.dirname(entry.filePath)]),
        ),
      ),
      shimPlugin(),
    ],
    external: EXTERNAL_PACKAGES,
  });

  await Promise.all(
    group.map((entry) =>
      fsPromises.rename(
        path.join(buildDir, entry.outName + outExtension),
        entry.compiledFilePath,
      ),
    ),
  );
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

  constructor(
    private readonly filePath: string,
    private readonly options = DEFAULT_AGENT_FILE_OPTIONS,
    private readonly compiled?: CompiledEntrypoint,
  ) {}

  async load(): Promise<BaseAgent | App> {
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
      const artifact =
        this.compiled ??
        (await compileEntrypoints([this.filePath], this.options)).get(
          this.filePath,
        )!;

      this.cleanupDirPath = artifact.outputDir;
      this.cleanupFilePath = artifact.compiledFilePath;
      filePath = artifact.compiledFilePath;
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
  private agentsAlreadyPreloaded = false;
  private readonly preloadedAgents: Record<string, AgentFile> = {};
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
    for (const agentFile of Object.values(this.preloadedAgents)) {
      agentFile.dispose().catch(() => {});
    }

    for (const key of Object.keys(this.preloadedAgents)) {
      delete this.preloadedAgents[key];
    }

    this.agentsAlreadyPreloaded = false;
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

  async getAgentFile(agentName: string): Promise<AgentFile> {
    await this.preloadAgents();

    return this.preloadedAgents[agentName];
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

  async preloadAgents() {
    if (this.agentsAlreadyPreloaded) {
      return;
    }

    const entrypoints = await this.discoverEntrypoints();
    const shouldCompile = this.options.compile || this.options.bundle;
    const compiled =
      shouldCompile && entrypoints.length > 0
        ? await compileEntrypoints(
            entrypoints.map((entrypoint) => entrypoint.filePath),
            this.options,
          )
        : new Map<string, CompiledEntrypoint>();

    await Promise.all(
      entrypoints.map(async ({name, filePath}) => {
        const agentFile = new AgentFile(
          filePath,
          this.options,
          compiled.get(filePath),
        );
        try {
          await agentFile.load();
          this.preloadedAgents[name] = agentFile;
        } catch (e) {
          if (e instanceof AgentFileLoadingError) {
            return;
          }
          throw e;
        }
      }),
    );

    this.agentsAlreadyPreloaded = true;

    if (this.watchForChanges && !this.watcher) {
      this.startWatching();
    }

    return;
  }

  /**
   * Scans the agents directory and returns every entrypoint it holds, without
   * compiling or importing any of them.
   */
  private async discoverEntrypoints(): Promise<DiscoveredEntrypoint[]> {
    const files = (await isFile(this.agentsDirPath))
      ? [await getFileMetadata(this.agentsDirPath)]
      : await getDirFiles(this.agentsDirPath);

    const entrypoints = await Promise.all(
      files.map(async (fileOrDir: FileMetadata) => {
        if (fileOrDir.isFile && isJsFile(fileOrDir.ext)) {
          return {name: fileOrDir.name, filePath: fileOrDir.path};
        }

        if (fileOrDir.isDirectory) {
          const entryFile = await findDirEntrypoint(fileOrDir.path);
          if (entryFile) {
            return {name: fileOrDir.name, filePath: entryFile};
          }
        }

        return undefined;
      }),
    );

    return entrypoints.filter(
      (entrypoint): entrypoint is DiscoveredEntrypoint =>
        entrypoint !== undefined,
    );
  }
}

/**
 * Returns the entrypoint of an agent directory, preferring `app.*` over
 * `agent.*`, or `undefined` when the directory holds neither.
 */
async function findDirEntrypoint(dirPath: string): Promise<string | undefined> {
  const subFiles = await getDirFiles(dirPath);
  const entryFile =
    subFiles.find((f) => f.isFile && f.name === 'app' && isJsFile(f.ext)) ??
    subFiles.find((f) => f.isFile && f.name === 'agent' && isJsFile(f.ext));

  return entryFile?.path;
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
