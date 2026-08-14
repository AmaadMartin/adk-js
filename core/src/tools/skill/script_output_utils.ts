/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {Context} from '../../agents/context.js';
import type {CodeExecutionResult} from '../../code_executors/code_execution_utils.js';
import {getFileContentAsBase64} from '../../code_executors/code_execution_utils.js';
import {materializeFiles} from '../../utils/file_utils.js';
import {logger} from '../../utils/logger.js';

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
 * An output file produced by a skill script and saved to the artifact service.
 */
export interface SavedOutputFile {
  /** Artifact filename the file was saved under. */
  name: string;
  mimeType: string;
}

/** Response returned by the skill script execution tools. */
export interface SkillScriptResponse {
  stdout: string;
  stderr: string;
  /**
   * Output files produced by the script. File bytes are deliberately omitted;
   * load them from the artifact service (e.g. the `load_artifacts` tool).
   */
  outputFiles: SavedOutputFile[];
  /**
   * Absolute path of the directory the output files were written to. Absent
   * when the script produced no output files.
   */
  outputDir?: string;
  /** Set when output files could not be persisted. */
  warning?: string;
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

/**
 * Saves the output files of a skill script execution to the artifact service
 * and returns a model-facing summary that never contains file bytes.
 *
 * The files are saved under the names `materializeScriptOutputs` wrote them
 * with, so an artifact matches the file in `outputDir` one for one. The
 * directory is reported back to the caller unchanged.
 *
 * When no artifact service is configured, the files cannot be persisted; the
 * produced filenames are still reported alongside an explicit warning so the
 * loss is never silent.
 *
 * @param toolContext The tool context owning the session's artifact service.
 * @param result The materialized result of the skill script execution.
 * @return The model-facing response for the skill script tools.
 */
export async function saveScriptOutputs(
  toolContext: Context,
  {stdout, stderr, outputFiles, outputDir}: SkillScriptResult,
): Promise<SkillScriptResponse> {
  const names = outputFiles.map(({name, mimeType}) => ({name, mimeType}));

  if (
    outputFiles.length > 0 &&
    !toolContext.invocationContext.artifactService
  ) {
    const warning =
      `No artifact service is configured; ${outputFiles.length} output ` +
      `file(s) produced by the script were not saved to the session.`;
    logger.warn(warning);
    return {stdout, stderr, outputFiles: names, outputDir, warning};
  }

  const outcomes = await Promise.allSettled(
    outputFiles.map((file) =>
      toolContext.saveArtifact(file.name, {
        inlineData: {
          data: getFileContentAsBase64(file),
          mimeType: file.mimeType,
        },
      }),
    ),
  );

  const saved: SavedOutputFile[] = [];
  const failed: string[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      saved.push(names[index]);
      return;
    }
    const {name} = names[index];
    failed.push(name);
    logger.warn(
      `Failed to save output file '${name}' to the artifact service.`,
      outcome.reason,
    );
  });

  if (failed.length === 0) {
    return {stdout, stderr, outputFiles: saved, outputDir};
  }

  return {
    stdout,
    stderr,
    outputFiles: saved,
    outputDir,
    warning:
      `Failed to save ${failed.length} of ${outputFiles.length} output ` +
      `file(s) to the artifact service: ${failed.join(', ')}.`,
  };
}
