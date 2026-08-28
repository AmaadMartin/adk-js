/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves the paths the Agent Builder file tools are asked to touch against
 * the project root, and refuses anything that lands outside it.
 *
 * Ported from `cli/built_in_agents/utils/resolve_root_directory.py` in
 * adk-python.
 */

import {ReadonlyContext, resolveWithinDir} from '@google/adk';
import * as path from 'node:path';

import {sanitizeGeneratedFilePath} from './path_normalizer.js';

/** Session state key holding the project root the file tools operate in. */
export const ROOT_DIRECTORY_STATE_KEY = 'root_directory';

/** Root directory used when the session state does not carry a usable one. */
const DEFAULT_ROOT_DIRECTORY = './';

/**
 * Reads the project root from the session state.
 *
 * A session that never set the key falls back to `./`, which the reference
 * also does. A session that set it to something other than a non-empty string
 * is an error: the reference raises there, and degrading to the working
 * directory would silently point a write or a delete at wherever the process
 * happens to be running.
 *
 * @param context The invocation context, absent when a tool is called
 *     directly. A tool context and an instruction provider's readonly context
 *     both satisfy it.
 * @return The configured root, or `./` when the session declares none.
 * @throws If the session state holds an unusable `root_directory`.
 */
export function rootDirectoryFromContext(context?: ReadonlyContext): string {
  const rootDirectory = context?.state.get<unknown>(ROOT_DIRECTORY_STATE_KEY);
  if (rootDirectory === undefined) {
    return DEFAULT_ROOT_DIRECTORY;
  }
  if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
    throw new Error(
      `Session state '${ROOT_DIRECTORY_STATE_KEY}' must be a non-empty string.`,
    );
  }
  return rootDirectory;
}

/**
 * Resolves `filePath` against `rootDirectory` and rejects anything outside it.
 *
 * Containment is core's {@link resolveWithinDir} check: lexical, a guard
 * against traversal rather than a sandbox, and no defence against symlinks,
 * hardlinks, bind mounts or TOCTOU races.
 *
 * This diverges from the reference in one way: Python's `Path.resolve()`
 * resolves symlinks, `path.resolve()` does not. A symlink inside the root that
 * points outside it is therefore **refused by adk-python and allowed here**,
 * so a caller can read, write or delete the file the link points at. Calling
 * `fs.realpath` to close that gap would add an asynchronous filesystem
 * round-trip and still lose the TOCTOU race, so the gap stays open and a test
 * pins it.
 *
 * @param filePath Relative or absolute path supplied by the model.
 * @param rootDirectory The project root, absolute or relative to the cwd.
 * @return The resolved absolute path, lexically inside the root.
 * @throws If the path resolves outside the root directory.
 */
export function resolveFilePath(
  filePath: string,
  rootDirectory: string,
): string {
  const candidate = resolveWithinDir(
    rootDirectory,
    sanitizeGeneratedFilePath(filePath),
  );
  if (candidate === undefined) {
    throw new Error(
      `File path '${filePath}' resolves outside the root directory ${path.resolve(rootDirectory)}.`,
    );
  }
  return candidate;
}

/**
 * Resolves every path in `filePaths`, preserving their order.
 *
 * One entry that escapes the root fails the whole batch rather than being
 * silently dropped.
 *
 * @param filePaths Relative or absolute paths supplied by the model.
 * @param rootDirectory The project root, absolute or relative to the cwd.
 * @return The resolved absolute paths, in input order.
 * @throws If any path resolves outside the root directory.
 */
export function resolveFilePaths(
  filePaths: string[],
  rootDirectory: string,
): string[] {
  return filePaths.map((filePath) => resolveFilePath(filePath, rootDirectory));
}
