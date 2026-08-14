/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File writing tool for the Agent Builder Assistant.
 *
 * Ported from `cli/built_in_agents/tools/write_files.py` in adk-python. The
 * reference also drops an `__init__.py` next to every written `.py` file and
 * reports the result in `package_inits_created`. That is Python packaging
 * semantics with no meaning in a JS or TS project, so neither the behaviour
 * nor the field is ported.
 */

import {Context, FunctionTool} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {z} from 'zod';

import {errorMessage} from '../../utils/error_utils.js';
import {createBackup} from '../utils/backup.js';
import {
  resolveFilePath,
  rootDirectoryFromContext,
} from '../utils/resolve_root_directory.js';

/** Outcome of writing a single file. */
export interface WriteFileInfo {
  file_size: number;
  existed_before: boolean;
  backup_created: boolean;
  backup_path: string | null;
  error: string | null;
}

/** Result payload of the `write_files` tool. */
export interface WriteFilesResult {
  success: boolean;
  /** Per-file outcome, keyed by resolved absolute path. */
  files: Record<string, WriteFileInfo>;
  successful_writes: number;
  total_files: number;
  errors: string[];
}

const writeFilesParameters = z.object({
  files: z
    .record(z.string(), z.string())
    .describe('Map of file path to the content to write.'),
  create_backup: z
    .boolean()
    .optional()
    .describe(
      'Copy an existing file to a timestamped backup before overwriting it. ' +
        'Defaults to false.',
    ),
  create_directories: z
    .boolean()
    .optional()
    .describe('Create missing parent directories. Defaults to true.'),
});

/** Arguments accepted by {@link writeFiles}. */
export type WriteFilesInput = z.infer<typeof writeFilesParameters>;

/**
 * Writes several UTF-8 text files, resolved against the project root held in
 * the session state.
 *
 * A path that escapes the root fails the whole batch, so nothing is written
 * outside the project.
 *
 * @param input The files to write and the backup and directory options.
 * @param context The tool context carrying the project root.
 * @return The per-file outcome of every write.
 */
export async function writeFiles(
  input: WriteFilesInput,
  context?: Context,
): Promise<WriteFilesResult> {
  const {
    files,
    create_backup: shouldBackUp = false,
    create_directories: shouldCreateDirectories = true,
  } = input;
  const entries = Object.entries(files);

  try {
    const rootDirectory = rootDirectoryFromContext(context);
    const result: WriteFilesResult = {
      success: true,
      files: {},
      successful_writes: 0,
      total_files: entries.length,
      errors: [],
    };

    for (const [filePath, content] of entries) {
      const resolvedPath = resolveFilePath(filePath, rootDirectory);
      const fileInfo: WriteFileInfo = {
        file_size: 0,
        existed_before: false,
        backup_created: false,
        backup_path: null,
        error: null,
      };

      try {
        fileInfo.existed_before =
          (await fs.stat(resolvedPath).catch(() => undefined)) !== undefined;

        if (shouldCreateDirectories) {
          await fs.mkdir(path.dirname(resolvedPath), {recursive: true});
        }

        if (shouldBackUp && fileInfo.existed_before) {
          try {
            fileInfo.backup_path = await createBackup(resolvedPath);
            fileInfo.backup_created = true;
          } catch (error: unknown) {
            fileInfo.error = `Failed to create backup: ${errorMessage(error)}`;
            result.success = false;
            result.files[resolvedPath] = fileInfo;
            continue;
          }
        }

        await fs.writeFile(resolvedPath, content, 'utf-8');

        const stats = await fs.stat(resolvedPath).catch(() => undefined);
        if (stats === undefined) {
          fileInfo.error = 'File was not created successfully';
          result.success = false;
        } else {
          fileInfo.file_size = stats.size;
          result.successful_writes++;
        }
      } catch (error: unknown) {
        fileInfo.error = `Write failed: ${errorMessage(error)}`;
        result.success = false;
      }

      result.files[resolvedPath] = fileInfo;
    }

    return result;
  } catch (error: unknown) {
    return {
      success: false,
      files: {},
      successful_writes: 0,
      total_files: entries.length,
      errors: [`Write operation failed: ${errorMessage(error)}`],
    };
  }
}

/** The `write_files` tool as the model sees it. */
export const writeFilesTool = new FunctionTool({
  name: 'write_files',
  description:
    'Write content to several text files, such as agent configurations and ' +
    'tool sources. Paths are resolved against the project root.',
  parameters: writeFilesParameters,
  execute: (input, context) => writeFiles(input, context),
});
