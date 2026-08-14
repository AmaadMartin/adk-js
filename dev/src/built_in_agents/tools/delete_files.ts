/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File deletion tool for the Agent Builder Assistant.
 *
 * Ported from `cli/built_in_agents/tools/delete_files.py` in adk-python.
 */

import {Context, FunctionTool} from '@google/adk';
import * as fs from 'node:fs/promises';
import {z} from 'zod';

import {errorMessage} from '../../utils/error_utils.js';
import {createBackup} from '../utils/backup.js';
import {
  resolveFilePaths,
  rootDirectoryFromContext,
} from '../utils/resolve_root_directory.js';

/** Outcome of deleting a single file. */
export interface DeleteFileInfo {
  existed: boolean;
  backup_created: boolean;
  backup_path: string | null;
  error: string | null;
  file_size: number;
}

/** Result payload of the `delete_files` tool. */
export interface DeleteFilesResult {
  success: boolean;
  /** Per-file outcome, keyed by resolved absolute path. */
  files: Record<string, DeleteFileInfo>;
  successful_deletions: number;
  total_files: number;
  errors: string[];
}

const deleteFilesParameters = z.object({
  file_paths: z
    .array(z.string())
    .describe('Absolute or relative paths of the files to delete.'),
  create_backup: z
    .boolean()
    .optional()
    .describe(
      'Copy each file to a timestamped backup before deleting it. Defaults ' +
        'to false.',
    ),
  confirm_deletion: z
    .boolean()
    .optional()
    .describe(
      'Whether the user confirmed the deletion. Nothing is deleted when this ' +
        'is false. Defaults to true.',
    ),
});

/** Arguments accepted by {@link deleteFiles}. */
export type DeleteFilesInput = z.infer<typeof deleteFilesParameters>;

/**
 * Deletes several files, resolved against the project root held in the session
 * state.
 *
 * A file that is already gone counts as a successful deletion and only records
 * an explanatory error, matching the reference implementation. A path that
 * escapes the root fails the whole batch, so nothing outside the project is
 * removed.
 *
 * @param input The paths to delete and the backup and confirmation options.
 * @param context The tool context carrying the project root.
 * @return The per-file outcome of every deletion.
 */
export async function deleteFiles(
  input: DeleteFilesInput,
  context?: Context,
): Promise<DeleteFilesResult> {
  const {
    file_paths: requestedPaths,
    create_backup: shouldBackUp = false,
    confirm_deletion: confirmDeletion = true,
  } = input;

  try {
    const resolvedPaths = resolveFilePaths(
      requestedPaths,
      rootDirectoryFromContext(context),
    );

    const result: DeleteFilesResult = {
      success: true,
      files: {},
      successful_deletions: 0,
      total_files: requestedPaths.length,
      errors: [],
    };

    if (!confirmDeletion) {
      result.success = false;
      result.errors.push('Deletion not confirmed by user');
      return result;
    }

    for (const resolvedPath of resolvedPaths) {
      const fileInfo: DeleteFileInfo = {
        existed: false,
        backup_created: false,
        backup_path: null,
        error: null,
        file_size: 0,
      };

      const stats = await fs.stat(resolvedPath).catch(() => undefined);
      if (stats === undefined) {
        fileInfo.error = `File does not exist: ${resolvedPath}`;
        result.files[resolvedPath] = fileInfo;
        // Nothing left to remove, so the caller's intent is already satisfied.
        result.successful_deletions++;
        continue;
      }

      fileInfo.existed = true;
      fileInfo.file_size = stats.size;

      try {
        if (shouldBackUp) {
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

        await fs.unlink(resolvedPath);
        result.successful_deletions++;
      } catch (error: unknown) {
        fileInfo.error = `Deletion failed: ${errorMessage(error)}`;
        result.success = false;
      }

      result.files[resolvedPath] = fileInfo;
    }

    return result;
  } catch (error: unknown) {
    return {
      success: false,
      files: {},
      successful_deletions: 0,
      total_files: requestedPaths.length,
      errors: [`Delete operation failed: ${errorMessage(error)}`],
    };
  }
}

/**
 * The `delete_files` tool as the model sees it.
 *
 * The wrapper requires an explicit user confirmation before it runs. The
 * ported `confirm_deletion` argument is supplied by the model and is therefore
 * not a gate; this one is enforced by the framework.
 */
export const deleteFilesTool = new FunctionTool({
  name: 'delete_files',
  description:
    'Delete several files from the project, for example tool sources an ' +
    'agent no longer references. Paths are resolved against the project root.',
  parameters: deleteFilesParameters,
  requireConfirmation: true,
  execute: (input, context) => deleteFiles(input, context),
});
