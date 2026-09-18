/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {loadFileData} from '../utils/file_utils.js';

/** The JSON document a scripted `adk run` reads its turns from. */
export interface RunInputFile {
  /** Initial session state. */
  state: Record<string, unknown>;
  /** The user turns to send, in order. */
  queries: string[];
}

/**
 * Both fields are required, matching adk-python's `InputFile` model, where
 * neither has a default.
 */
const RUN_INPUT_FILE_SCHEMA = z.object({
  state: z.record(z.string(), z.unknown()),
  queries: z.array(z.string()),
});

/** Names the field an issue is about. An empty path means the document itself. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.join('.');
  return field ? `${field}: ${issue.message}` : issue.message;
}

/**
 * Reads a run input file and validates it against {@link RunInputFile}.
 *
 * @param filePath Absolute path of the file to read.
 * @throws Error naming the file and every field that failed, so a typo such as
 *     `query` for `queries` stops the run before the first model call.
 */
export async function loadRunInputFile(
  filePath: string,
): Promise<RunInputFile> {
  const contents = await loadFileData<unknown>(filePath);
  const result = RUN_INPUT_FILE_SCHEMA.safeParse(contents);
  if (!result.success) {
    const details = result.error.issues.map(describeIssue).join('; ');
    throw new Error(`Invalid run input file ${filePath}: ${details}`);
  }
  return result.data;
}
