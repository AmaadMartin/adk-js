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

const OUTPUT_DIR_PREFIX = 'adk-skill-outputs-';

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
 * Writes the output files of a skill script execution to disk and reports
 * where they went.
 *
 * With `outputDir` set, files are written under it (a relative path is
 * resolved against the host process's working directory). Without it, a fresh
 * directory is created for this execution under the OS temp directory, so
 * script-chosen filenames never land in whichever directory the host process
 * was launched from. Nothing is written and no directory is created when the
 * script produced no output files.
 *
 * The directory is **not** cleaned up — it holds the artifacts the caller asked
 * for. Unconfigured runs therefore rely on OS temp-directory cleanup; pass
 * `outputDir` to put the files somewhere the application manages.
 *
 * @param result The result returned by the code executor.
 * @param outputDir Directory to write the output files into.
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
    : await fs.mkdtemp(path.join(os.tmpdir(), OUTPUT_DIR_PREFIX));

  return {
    ...result,
    outputFiles: await materializeFiles(result.outputFiles, dir),
    outputDir: dir,
  };
}
