/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {
  CodeExecutionResult,
  File,
  toBase64Content,
} from '../../code_executors/code_execution_utils.js';
import {logger} from '../../utils/logger.js';

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
  /** Set when output files could not be persisted. */
  warning?: string;
}

/**
 * Saves the output files of a skill script execution to the artifact service
 * and returns a model-facing summary that never contains file bytes.
 *
 * When no artifact service is configured, the files cannot be persisted; the
 * produced filenames are still reported alongside an explicit warning so the
 * loss is never silent.
 *
 * @param toolContext The tool context owning the session's artifact service.
 * @param result The result returned by the code executor.
 * @return The model-facing response for the skill script tools.
 */
export async function saveScriptOutputs(
  toolContext: Context,
  result: CodeExecutionResult,
): Promise<SkillScriptResponse> {
  const {stdout, stderr, outputFiles} = result;

  if (outputFiles.length === 0) {
    return {stdout, stderr, outputFiles: []};
  }

  if (!toolContext.invocationContext.artifactService) {
    const warning =
      `No artifact service is configured; ${outputFiles.length} output ` +
      `file(s) produced by the script were discarded.`;
    logger.warn(warning);
    return {
      stdout,
      stderr,
      outputFiles: outputFiles.map(describeFile),
      warning,
    };
  }

  const outcomes = await Promise.allSettled(
    outputFiles.map((file) =>
      toolContext.saveArtifact(file.name, {
        inlineData: {data: toBase64Content(file), mimeType: file.mimeType},
      }),
    ),
  );

  const saved: SavedOutputFile[] = [];
  const failed: string[] = [];
  outcomes.forEach((outcome, index) => {
    const file = outputFiles[index];
    if (outcome.status === 'fulfilled') {
      saved.push(describeFile(file));
      return;
    }
    failed.push(file.name);
    logger.warn(
      `Failed to save output file '${file.name}' to the artifact service.`,
      outcome.reason,
    );
  });

  if (failed.length === 0) {
    return {stdout, stderr, outputFiles: saved};
  }

  return {
    stdout,
    stderr,
    outputFiles: saved,
    warning:
      `Failed to save ${failed.length} of ${outputFiles.length} output ` +
      `file(s) to the artifact service: ${failed.join(', ')}.`,
  };
}

function describeFile({name, mimeType}: File): SavedOutputFile {
  return {name, mimeType};
}
