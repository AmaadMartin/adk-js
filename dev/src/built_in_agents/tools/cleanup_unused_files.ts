/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unused-file scanner for the Agent Builder Assistant.
 *
 * Ported from `cli/built_in_agents/tools/cleanup_unused_files.py` in
 * adk-python.
 */

import {Context, FunctionTool} from '@google/adk';
import fg from 'fast-glob';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {z} from 'zod';

import {errorMessage} from '../../utils/error_utils.js';
import {
  resolveFilePath,
  resolveFilePaths,
  rootDirectoryFromContext,
} from '../utils/resolve_root_directory.js';

/** File patterns scanned when the caller names none. */
const DEFAULT_FILE_PATTERNS = ['*.py'];

/** Patterns never reported as unused when the caller names none. */
const DEFAULT_EXCLUDE_PATTERNS = ['__init__.py', '*_test.py', 'test_*.py'];

/**
 * Result payload of the `cleanup_unused_files` tool.
 *
 * `deleted_files`, `backup_files` and `total_freed_space` are always empty:
 * the scan reports files and removes none. They are kept because the model
 * sees this payload and the reference returns the same three keys, always
 * empty as well. See {@link emptyReport}.
 */
export interface CleanupUnusedFilesResult {
  success: boolean;
  /** Absolute paths of the files that no listed file references. */
  unused_files: string[];
  deleted_files: string[];
  backup_files: string[];
  errors: string[];
  total_freed_space: number;
}

const cleanupUnusedFilesParameters = z.object({
  used_files: z
    .array(z.string())
    .describe('Paths of the files still in use, which must not be reported.'),
  file_patterns: z
    .array(z.string())
    .optional()
    .describe(
      `Glob patterns matched against every file in the project. Defaults to ${JSON.stringify(DEFAULT_FILE_PATTERNS)}.`,
    ),
  exclude_patterns: z
    .array(z.string())
    .optional()
    .describe(
      `Patterns never reported as unused. Defaults to ${JSON.stringify(DEFAULT_EXCLUDE_PATTERNS)}.`,
    ),
});

/** Arguments accepted by {@link cleanupUnusedFiles}. */
export type CleanupUnusedFilesInput = z.infer<
  typeof cleanupUnusedFilesParameters
>;

/** The report every return path starts from: nothing found, nothing removed. */
function emptyReport(): CleanupUnusedFilesResult {
  return {
    success: false,
    unused_files: [],
    deleted_files: [],
    backup_files: [],
    errors: [],
    total_freed_space: 0,
  };
}

/**
 * Rewrites a pattern so it matches at any depth under the root.
 *
 * `Path.rglob(p)` walks the whole tree, and `Path.match(p)` matches from the
 * right, so both behave like a pattern prefixed with a globstar. The rewrite
 * is stricter than `rglob` in one case: a pattern that starts with `..` lists
 * files outside the root in Python, and matches nothing here. A model-supplied
 * pattern that reaches out of the project is not behaviour worth reproducing.
 */
function anyDepth(pattern: string): string {
  return pattern.startsWith('**/') ? pattern : `**/${pattern}`;
}

/**
 * Lists the files under the project root that no entry of `used_files`
 * references.
 *
 * The scan only identifies files; it never deletes anything, so
 * `deleted_files`, `backup_files` and `total_freed_space` stay empty. Deletion
 * is the `delete_files` tool's job, behind its confirmation gate.
 *
 * @param input The files in use and the patterns to scan.
 * @param context The tool context carrying the project root.
 * @return The unused files found, or the reason the scan did not run.
 */
export async function cleanupUnusedFiles(
  input: CleanupUnusedFilesInput,
  context?: Context,
): Promise<CleanupUnusedFilesResult> {
  const {
    used_files: usedFiles,
    file_patterns: filePatterns = DEFAULT_FILE_PATTERNS,
    exclude_patterns: excludePatterns = DEFAULT_EXCLUDE_PATTERNS,
  } = input;

  try {
    const rootDirectory = rootDirectoryFromContext(context);
    const rootPath = resolveFilePath('.', rootDirectory);
    // A used file outside the root aborts the scan rather than leaving
    // everything under the root looking unused.
    const resolvedUsedFiles = new Set(
      resolveFilePaths(usedFiles, rootDirectory),
    );

    if ((await fs.stat(rootPath).catch(() => undefined)) === undefined) {
      return {
        ...emptyReport(),
        errors: [`Root directory does not exist: ${rootPath}`],
      };
    }

    // `onlyFiles` narrows the reference behaviour: `rglob('*.py')` also returns
    // a directory named `foo.py`, and a directory is not a deletable file.
    const matches = await fg(filePatterns.map(anyDepth), {
      cwd: rootPath,
      absolute: true,
      dot: true,
      followSymbolicLinks: false,
      onlyFiles: true,
      ignore: excludePatterns.map(anyDepth),
    });

    return {
      ...emptyReport(),
      success: true,
      unused_files: matches
        .map((match) => path.resolve(match))
        .filter((match) => !resolvedUsedFiles.has(match)),
    };
  } catch (error: unknown) {
    return {
      ...emptyReport(),
      errors: [`Cleanup scan failed: ${errorMessage(error)}`],
    };
  }
}

/** The `cleanup_unused_files` tool as the model sees it. */
export const cleanupUnusedFilesTool = new FunctionTool({
  name: 'cleanup_unused_files',
  description:
    'List the project files that no longer appear in the set of files in ' +
    'use, for example tool sources an agent configuration stopped ' +
    'referencing. This only reports files; it deletes nothing.',
  parameters: cleanupUnusedFilesParameters,
  execute: (input, context) => cleanupUnusedFiles(input, context),
});
