/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

import {linkProjectNodeModules} from './agent_loader.js';
import {createTempDir, removeFolder} from './file_utils.js';

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

/**
 * Imports a module the user wrote, compiling it first when it is TypeScript.
 *
 * Packages stay external, so the module shares this process's copy of every
 * dependency. Inlining `@google/adk` would give the user's code a second copy
 * of the package, whose classes and singletons are not the ones the CLI holds.
 *
 * @param filePath Absolute path of the module to import.
 * @return The exports of the module.
 */
export async function importUserModule(
  filePath: string,
): Promise<Record<string, unknown>> {
  if (!TYPESCRIPT_EXTENSIONS.has(path.extname(filePath))) {
    return import(pathToFileURL(filePath).href);
  }

  const outputDir = await createTempDir('adk_user_module');
  try {
    const outFile = path.join(outputDir, `${path.parse(filePath).name}.mjs`);
    await linkProjectNodeModules(outputDir, path.dirname(filePath));
    await esbuild.build({
      entryPoints: [filePath],
      outfile: outFile,
      bundle: true,
      packages: 'external',
      format: 'esm',
      platform: 'node',
    });

    // Awaited here, not returned: the `finally` below deletes the file, and it
    // must not run before Node has read it.
    return await import(pathToFileURL(outFile).href);
  } finally {
    await removeFolder(outputDir);
  }
}
