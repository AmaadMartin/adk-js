/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {CodeExecutionResult} from '../../code_executors/code_execution_utils.js';
import {materializeFiles} from '../../utils/file_utils.js';

/**
 * Prefix for the per-call temp directory created when no output directory is
 * declared on the toolset.
 */
const SKILL_OUTPUT_DIR_PREFIX = 'adk-skill-output-';

/**
 * A code-execution result whose output files have been written to disk.
 */
export interface MaterializedCodeExecutionResult extends CodeExecutionResult {
  /**
   * Absolute path of the tool-owned directory the files in `outputFiles` were
   * written to. Each `outputFiles[i].name` is a path relative to this
   * directory. Absent when the script produced no output files.
   */
  outputDir?: string;
}

/**
 * Writes `result.outputFiles` into a directory owned by the caller and returns
 * the result annotated with that directory. Anchoring materialization to a
 * declared directory keeps script-chosen file names from resolving against the
 * agent process's working directory.
 */
export async function materializeSkillOutputFiles(
  result: CodeExecutionResult,
  declaredDir?: string,
): Promise<MaterializedCodeExecutionResult> {
  if (!result.outputFiles.length) {
    return result;
  }

  const outputDir = declaredDir
    ? path.resolve(declaredDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), SKILL_OUTPUT_DIR_PREFIX));
  await fs.mkdir(outputDir, {recursive: true});
  const outputFiles = await materializeFiles(result.outputFiles, outputDir);
  return {...result, outputFiles, outputDir};
}
