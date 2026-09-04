/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import {randomUUID} from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Extensions that Node cannot import without transpiling them first. */
const TYPESCRIPT_EXTENSIONS = ['.ts', '.mts', '.cts'];

/**
 * Imports a JavaScript or TypeScript module file and returns its exports.
 *
 * A TypeScript file is transpiled with esbuild first, because the Node
 * versions this CLI runs on do not all import TypeScript directly.
 *
 * Every package it imports stays an import, so the module reaches the same
 * singletons its caller holds; bundling `@google/adk-devtools` would hand it a
 * private registry nothing else can see. Its relative imports are inlined
 * instead, because TypeScript spells a sibling `./backend.ts` as
 * `./backend.js`, and only a bundler resolves that back to the file on disk.
 *
 * The transpiled file is written beside the original so that a package still
 * resolves exactly as it would have for the source.
 */
export async function importModuleFile(filePath: string): Promise<unknown> {
  if (!TYPESCRIPT_EXTENSIONS.includes(path.extname(filePath))) {
    return import(pathToFileURL(filePath).href);
  }

  const transpiledPath = path.join(
    path.dirname(filePath),
    `.${path.parse(filePath).name}.${randomUUID()}.mjs`,
  );
  try {
    await esbuild.build({
      entryPoints: [filePath],
      outfile: transpiledPath,
      platform: 'node',
      format: 'esm',
      bundle: true,
      packages: 'external',
    });
    return await import(pathToFileURL(transpiledPath).href);
  } finally {
    await fsPromises.rm(transpiledPath, {force: true});
  }
}
