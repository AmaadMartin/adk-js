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
 * Supported file extensions for JavaScript and TypeScript, most preferred
 * first. The order is load bearing: where two entry points differ only by
 * extension, the TypeScript source is the file a developer edits, so it wins
 * over a compiled sibling.
 */
// Not derived from FILE_EXTENSION_LOADER_MAP: .jsx/.tsx must never become
// discoverable agent files.
const JS_FILES_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

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
 * Entrypoint file names an agent directory can use, in the order the loader
 * tries them.
 */
const DIRECTORY_ENTRY_FILE_NAMES = ['app', 'agent', 'index'];

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
 * Packages that must never be inlined into the bundled agent file.
 *
 * See http://mikro-orm.io/docs/deployment#deploy-a-bundle-of-entities-and-dependencies-with-esbuild for more details
 */
const EXTERNAL_PACKAGES = [
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
  /**
   * Whether to inline the agent's dependencies into the single compiled file.
   *
   * With bundling enabled every relative import is inlined. With bundling
   * disabled only the entry file is compiled, so the agent must be a single
   * self-contained file: a relative import is rejected by `AgentFile.load()`.
   */
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

      const buildResult = await esbuild.build({
        entryPoints: [filePath],
        outfile: compiledFilePath,
        target: 'node16',
        platform: 'node',
        format: moduleType,
        bundle: this.options.bundle,
        minify: this.options.bundle,
        plugins: [replaceDirnamePlugin(), shimPlugin()],
        // esbuild rejects `packages` and `external` unless it is bundling, so
        // both have to be withheld when `--bundle false` asks it only to
        // transpile. Nothing is being inlined in that mode, so there is
        // nothing to hold out of the bundle either. The metafile is the
        // reverse: it is only needed to detect the relative imports that a
        // non-bundled build leaves unresolved.
        ...(this.options.bundle
          ? {packages: 'bundle' as const, external: EXTERNAL_PACKAGES}
          : {metafile: true}),
      });

      this.cleanupFilePath = compiledFilePath;

      const relativeImports = buildResult?.metafile
        ? findUnresolvedRelativeImports(buildResult.metafile)
        : [];
      if (relativeImports.length > 0) {
        const specifiers = relativeImports
          .map((specifier) => `"${specifier}"`)
          .join(', ');
        const message =
          `Agent file ${this.filePath} imports relative module(s) ` +
          `${specifiers}, but bundling is disabled. Without bundling only ` +
          `the entry file is compiled, into a temporary directory, so ` +
          `relative imports cannot be resolved at runtime. Re-run with ` +
          `bundling enabled (the default, or --bundle true), or make the ` +
          `agent a single self-contained file.`;
        logger.error(message);
        await this.dispose();
        throw new AgentFileLoadingError(message);
      }

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
 * - agents_dir/{agentOrAppName}/index.[js | ts | mjs | cjs]
 *
 * A name that has more than one of these resolves by precedence, so the served
 * agent never depends on directory order or on which build finishes first:
 * - a top-level file beats a directory of the same name;
 * - inside a directory, `app` beats `agent`, and `agent` beats `index`;
 * - between two files that differ only by extension, TypeScript beats
 *   JavaScript.
 *
 * The loader logs a warning for a name it resolves this way, and never builds
 * the candidate it drops. The one exception is an entry point that exports no
 * agent: it is a helper module of that name, so the loader tries the next
 * name in the order.
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
    const entries = (await isFile(this.agentsDirPath))
      ? [await getFileMetadata(this.agentsDirPath)]
      : await getDirFiles(this.agentsDirPath);

    const entryFilesByName = groupEntryFilesByName(entries);
    const directories = entries.filter(isAgentDirectory);

    await Promise.all([
      ...[...entryFilesByName].map(([name, [entryFile, ...ignored]]) => {
        const shadowedDir = directories.find((dir) => dir.name === name);
        warnShadowedEntries(name, entryFile.path, [
          ...ignored.map((file) => file.path),
          ...(shadowedDir ? [shadowedDir.path] : []),
        ]);

        return this.loadAgentFromFile(entryFile);
      }),
      ...directories
        .filter((dir) => !entryFilesByName.has(dir.name))
        .map((dir) => this.loadAgentFromDirectory(dir)),
    ]);

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

    for (const [entryFile, ...ignored] of directoryEntryFiles(subFiles)) {
      // `app` beating `agent` beating `index` is the documented layout, not an
      // ambiguity, so only a same-named sibling counts as a dropped candidate
      // here.
      warnShadowedEntries(
        dir.name,
        entryFile.path,
        ignored.map((file) => file.path),
      );

      const agentFile = new AgentFile(entryFile.path, this.options);
      try {
        await agentFile.load();
        this.preloadedAgents[dir.name] = agentFile;
        return;
      } catch (e) {
        await agentFile.dispose();

        // A candidate that exports no agent is a helper module of the same
        // name, so keep looking. Any other error means this file *is* the
        // agent and it is broken — report it rather than hide it behind a
        // lower-precedence file.
        if (e instanceof AgentFileLoadingError) {
          continue;
        }

        this.recordLoadFailure(dir.name, entryFile.path, e);
        return;
      }
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

/**
 * Returns the relative module specifiers (`./x`, `../x`) that the compiled
 * output still imports.
 *
 * Only meaningful for a non-bundled build: esbuild leaves such specifiers
 * untouched when `bundle` is false, and records them on the output entry of
 * the metafile with `external: true`.
 */
function findUnresolvedRelativeImports(metafile: esbuild.Metafile): string[] {
  const specifiers = Object.values(metafile.outputs).flatMap((output) =>
    output.imports.map((imported) => imported.path),
  );

  return [
    ...new Set(
      specifiers.filter((s) => s.startsWith('./') || s.startsWith('../')),
    ),
  ];
}

function isJsFile(fileExt?: string): boolean {
  return !!fileExt && JS_FILES_EXTENSIONS.includes(fileExt);
}

/** A file the loader can build and import as an entry point. */
type EntryFile = FileMetadata & {ext: string};

function isEntryFile(file: FileMetadata): file is EntryFile {
  return file.isFile && isJsFile(file.ext);
}

/** The entry points among `files`, most preferred extension first. */
function sortEntryFiles(files: FileMetadata[]): EntryFile[] {
  return files
    .filter(isEntryFile)
    .sort(
      (a, b) =>
        JS_FILES_EXTENSIONS.indexOf(a.ext) - JS_FILES_EXTENSIONS.indexOf(b.ext),
    );
}

/**
 * Top-level entry points grouped by the name they are served under, each group
 * ordered by precedence.
 */
function groupEntryFilesByName(
  files: FileMetadata[],
): Map<string, EntryFile[]> {
  const groups = new Map<string, EntryFile[]>();

  for (const file of sortEntryFiles(files)) {
    const group = groups.get(file.name) ?? [];
    group.push(file);
    groups.set(file.name, group);
  }

  return groups;
}

/**
 * The entry points a directory offers, grouped by entry name and ordered by
 * {@link DIRECTORY_ENTRY_FILE_NAMES}, so that an App wins over the agent it
 * wraps. Each group holds the files of one name, most preferred extension
 * first. A name the directory does not use has no group.
 */
function directoryEntryFiles(
  subFiles: FileMetadata[],
): Array<[EntryFile, ...EntryFile[]]> {
  return DIRECTORY_ENTRY_FILE_NAMES.map((entryName) =>
    sortEntryFiles(subFiles.filter((file) => file.name === entryName)),
  ).filter((group): group is [EntryFile, ...EntryFile[]] => group.length > 0);
}

function isAgentDirectory(entry: FileMetadata): boolean {
  return (
    entry.isDirectory &&
    entry.name !== 'node_modules' &&
    !entry.name.startsWith('.')
  );
}

/**
 * Reports the candidates a name resolved away from. A duplicate definition is
 * a misconfiguration the developer has to see, but it must not stop the
 * winning agent from loading.
 */
function warnShadowedEntries(
  name: string,
  used: string,
  ignored: string[],
): void {
  if (ignored.length === 0) {
    return;
  }

  logger.warn(
    `Agent '${name}' has more than one definition. Using ${used}; ` +
      `ignoring ${ignored.join(', ')}.`,
  );
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
