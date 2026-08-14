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

import {Context} from '@google/adk';
import * as path from 'node:path';

import {sanitizeGeneratedFilePath} from './path_normalizer.js';

/** Session state key holding the project root the file tools operate in. */
export const ROOT_DIRECTORY_STATE_KEY = 'root_directory';

/** Root directory used when the session state does not carry a usable one. */
const DEFAULT_ROOT_DIRECTORY = './';

/**
 * Reads the project root from the session state.
 *
 * The reference implementation indexes the state dictionary and fails on a
 * missing or non-string value. Falling back to the default is the defensive
 * equivalent: the value reaches us from a session an untrusted turn can write.
 *
 * @param context The tool context, absent when a tool is called directly.
 * @return The configured root, or `./` when none is usable.
 */
export function rootDirectoryFromContext(context?: Context): string {
  const rootDirectory = context?.state.get<unknown>(ROOT_DIRECTORY_STATE_KEY);
  return typeof rootDirectory === 'string' && rootDirectory.length > 0
    ? rootDirectory
    : DEFAULT_ROOT_DIRECTORY;
}

/**
 * Resolves `filePath` against `rootDirectory` and rejects anything outside it.
 *
 * Containment is a **lexical** check on the two resolved path strings, in the
 * shape used by `resolvePathInWorkingDir` in core's `local_environment.ts`: a
 * bare `startsWith` would accept a sibling whose name merely shares the prefix,
 * so the relative path is inspected for `..` and for the absolute result that
 * `path.relative` returns across Windows drives. It guards against traversal;
 * it is not a sandbox, and it does not survive symlinks, hardlinks, bind mounts
 * or TOCTOU races.
 *
 * This diverges from the reference in one way: Python's `Path.resolve()`
 * resolves symlinks, `path.resolve()` does not. A symlink inside the root that
 * points outside it is therefore contained by adk-python and refused here.
 * Calling `fs.realpath` to close that gap would add an asynchronous filesystem
 * round-trip and still lose the TOCTOU race, so it is left as is.
 *
 * @param filePath Relative or absolute path supplied by the model.
 * @param rootDirectory The project root, absolute or relative.
 * @param workingDirectory Base for a relative root; defaults to the cwd.
 * @return The resolved absolute path, guaranteed inside the root.
 * @throws If the path resolves outside the root directory.
 */
export function resolveFilePath(
  filePath: string,
  rootDirectory: string,
  workingDirectory?: string,
): string {
  const normalizedPath = sanitizeGeneratedFilePath(filePath);

  const resolvedRoot = path.isAbsolute(rootDirectory)
    ? path.resolve(rootDirectory)
    : path.resolve(workingDirectory ?? process.cwd(), rootDirectory);

  const candidate = path.isAbsolute(normalizedPath)
    ? path.resolve(normalizedPath)
    : path.resolve(resolvedRoot, normalizedPath);

  const relative = path.relative(resolvedRoot, candidate);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `File path '${filePath}' resolves outside the root directory ${resolvedRoot}.`,
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
 * @param rootDirectory The project root, absolute or relative.
 * @param workingDirectory Base for a relative root; defaults to the cwd.
 * @return The resolved absolute paths, in input order.
 * @throws If any path resolves outside the root directory.
 */
export function resolveFilePaths(
  filePaths: string[],
  rootDirectory: string,
  workingDirectory?: string,
): string[] {
  return filePaths.map((filePath) =>
    resolveFilePath(filePath, rootDirectory, workingDirectory),
  );
}
