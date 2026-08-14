/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File reading tool for the Agent Builder Assistant.
 *
 * Ported from `cli/built_in_agents/tools/read_files.py` in adk-python.
 */

import {Context, FunctionTool} from '@google/adk';
import * as fs from 'node:fs/promises';
import {z} from 'zod';

import {errorMessage} from '../../utils/error_utils.js';
import {
  resolveFilePaths,
  rootDirectoryFromContext,
} from '../utils/resolve_root_directory.js';

/**
 * Decoder that rejects malformed input, so a binary file is reported as a
 * per-file error instead of being served to the model as U+FFFD noise.
 */
const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true});

/** Outcome of reading a single file. */
export interface ReadFileInfo {
  content: string;
  file_size: number;
  exists: boolean;
  error: string | null;
}

/** Result payload of the `read_files` tool. */
export interface ReadFilesResult {
  success: boolean;
  /** Per-file outcome, keyed by resolved absolute path. */
  files: Record<string, ReadFileInfo>;
  successful_reads: number;
  total_files: number;
  errors: string[];
}

const readFilesParameters = z.object({
  file_paths: z
    .array(z.string())
    .describe('Absolute or relative paths of the files to read.'),
});

/** Arguments accepted by {@link readFiles}. */
export type ReadFilesInput = z.infer<typeof readFilesParameters>;

/**
 * Reads several text files, resolved against the project root held in the
 * session state.
 *
 * A file that does not exist is reported per file and leaves `success` true,
 * matching the reference implementation. A path that escapes the root fails
 * the whole batch and returns no file entries at all.
 *
 * @param input The paths to read.
 * @param context The tool context carrying the project root.
 * @return The contents read, and the errors for those that could not be.
 */
export async function readFiles(
  input: ReadFilesInput,
  context?: Context,
): Promise<ReadFilesResult> {
  const requestedPaths = input.file_paths;
  try {
    const resolvedPaths = resolveFilePaths(
      requestedPaths,
      rootDirectoryFromContext(context),
    );

    const result: ReadFilesResult = {
      success: true,
      files: {},
      successful_reads: 0,
      total_files: requestedPaths.length,
      errors: [],
    };

    for (const resolvedPath of resolvedPaths) {
      const fileInfo: ReadFileInfo = {
        content: '',
        file_size: 0,
        exists: false,
        error: null,
      };

      // An unreadable path is reported as missing, as Python's `Path.exists()`
      // does when it swallows the underlying OS error.
      const stats = await fs.stat(resolvedPath).catch(() => undefined);
      if (stats === undefined) {
        fileInfo.error = `File does not exist: ${resolvedPath}`;
      } else {
        fileInfo.exists = true;
        fileInfo.file_size = stats.size;
        try {
          fileInfo.content = UTF8_DECODER.decode(
            await fs.readFile(resolvedPath),
          );
          result.successful_reads++;
        } catch (error: unknown) {
          fileInfo.error = `Failed to read ${resolvedPath}: ${errorMessage(error)}`;
          result.success = false;
        }
      }

      result.files[resolvedPath] = fileInfo;
    }

    return result;
  } catch (error: unknown) {
    return {
      success: false,
      files: {},
      successful_reads: 0,
      total_files: requestedPaths.length,
      errors: [`Read operation failed: ${errorMessage(error)}`],
    };
  }
}

/** The `read_files` tool as the model sees it. */
export const readFilesTool = new FunctionTool({
  name: 'read_files',
  description:
    'Read the content of several text files, such as agent configurations ' +
    'and tool sources. Paths are resolved against the project root.',
  parameters: readFilesParameters,
  execute: (input, context) => readFiles(input, context),
});
