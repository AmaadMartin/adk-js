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
 * The result of a skill script execution, annotated with the directory its
 * output files were written to.
 */
export interface SkillScriptResult extends CodeExecutionResult {
  /**
   * Absolute path of the directory the output files were written to. Absent
   * when the script produced no output files.
   */
  outputDir?: string;
}

/**
 * Writes the output files of a skill script execution under `outputDir`, or
 * into a fresh per-execution directory in the OS temp directory when it is
 * unset. Nothing is written when the script produced no output files.
 *
 * @param result The result returned by the code executor.
 * @param outputDir Directory to write the output files into. See
 *     `SkillToolset`'s option of the same name for the lifetime policy.
 * @returns The result with each output file name rewritten relative to the
 *     output directory, plus the absolute `outputDir` the files went to.
 */
export async function materializeScriptOutputs(
  result: CodeExecutionResult,
  outputDir?: string,
): Promise<SkillScriptResult> {
  if (result.outputFiles.length === 0) {
    return result;
  }

  const dir = outputDir
    ? path.resolve(outputDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-outputs-'));

  return {
    ...result,
    outputFiles: await materializeFiles(result.outputFiles, dir),
    outputDir: dir,
  };
}
