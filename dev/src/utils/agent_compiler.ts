/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import {shimPlugin} from 'esbuild-shim-plugin';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

import {
  createTempDir,
  isFileExists,
  isFolderExists,
  loadFileData,
  removeFolder,
  tryToFindFileRecursively,
} from './file_utils.js';

/**
 * File extensions that esbuild must read with its TypeScript loader.
 */
const TS_FILES_EXTENSIONS = ['.ts', '.mts', '.cts'];

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

/** Compilation options shared by every entrypoint of a batch. */
export interface CompileOptions {
  bundle?: boolean;
  moduleType?: FileModuleType;
}

/** A compiled agent entrypoint together with the temp dir that owns it. */
export interface CompiledEntrypoint {
  outputDir: string;
  compiledFilePath: string;
}

/** An entrypoint with everything the batched build needs to emit it. */
interface PreparedEntrypoint extends CompiledEntrypoint {
  filePath: string;
  moduleType: FileModuleType;
  outName: string;
}

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
    setup(build: Pick<esbuild.PluginBuild, 'onLoad'>) {
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
 * @param options - Compilation options shared by every entry.
 * @returns The compiled artifact of each entry, in the order given.
 */
export async function compileEntrypoints(
  filePaths: readonly string[],
  options: CompileOptions,
): Promise<CompiledEntrypoint[]> {
  const prepared: PreparedEntrypoint[] = await Promise.all(
    filePaths.map(async (filePath, index) => {
      const moduleType =
        options.moduleType || (await getFileModuleType(filePath));
      const parsedPath = path.parse(filePath);
      const outputDir = await createTempDir('adk_agent_loader');
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

  const buildDir = await createTempDir('adk_agent_build');
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

  return prepared;
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
  return Object.values(FileModuleType)
    .map((moduleType) => entries.filter((e) => e.moduleType === moduleType))
    .filter((group) => group.length > 0);
}

/**
 * Compiles one same-module-type group in a single esbuild build, then moves
 * each output from the shared scratch directory into that entry's own temp dir.
 */
async function buildGroup(
  group: readonly PreparedEntrypoint[],
  buildDir: string,
  options: CompileOptions,
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
