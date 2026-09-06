/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

import {linkProjectNodeModules} from './agent_loader.js';
import {createTempDir} from './file_utils.js';

/** TypeScript extensions and the JavaScript each one transpiles to. */
const TYPESCRIPT_OUTPUT_EXTENSIONS: Record<string, string> = {
  '.ts': '.mjs',
  '.mts': '.mjs',
  '.cts': '.cjs',
};

const OUTPUT_FORMATS: Record<string, 'esm' | 'cjs'> = {
  '.mjs': 'esm',
  '.cjs': 'cjs',
};

/**
 * Transpiles rather than bundles.
 *
 * A bundle inlines `@google/adk-devtools`, giving the imported file its own
 * copy of every module singleton. A file that registers itself against a
 * process-wide registry would then register against a second, unread one.
 */
async function transpileTypeScript(
  filePath: string,
  outputExtension: string,
): Promise<string> {
  const sourceDir = path.dirname(filePath);
  const outputDir = await createTempDir('adk_module_utils');
  const outfile = path.join(
    outputDir,
    path.parse(filePath).name + outputExtension,
  );
  // The transpiled file keeps its bare imports, so it needs the project's
  // packages reachable from where it now sits.
  await linkProjectNodeModules(outputDir, sourceDir);

  await esbuild.build({
    entryPoints: [filePath],
    outfile,
    target: 'node16',
    platform: 'node',
    format: OUTPUT_FORMATS[outputExtension],
    bundle: false,
  });

  return outfile;
}

/**
 * Imports a module file for its side effects, compiling TypeScript first.
 *
 * The import is uncached: a file imported twice in one process runs twice.
 *
 * @param filePath Absolute path of a `.ts`, `.mts`, `.cts`, `.js`, `.mjs` or
 *     `.cjs` file.
 */
export async function importModuleFile(filePath: string): Promise<void> {
  const outputExtension =
    TYPESCRIPT_OUTPUT_EXTENSIONS[path.parse(filePath).ext];
  if (!outputExtension) {
    await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`);
    return;
  }

  const compiled = await transpileTypeScript(filePath, outputExtension);
  try {
    await import(`${pathToFileURL(compiled).href}?t=${Date.now()}`);
  } finally {
    await fs.rm(path.dirname(compiled), {recursive: true, force: true});
  }
}
