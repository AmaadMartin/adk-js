/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eval run results stored on the local file system, under the agents
 * directory.
 *
 * A port of adk-python's
 * `src/google/adk/evaluation/local_eval_set_results_manager.py`. The on-disk
 * layout is
 * `<agentsDir>/<appName>/.adk/eval_history/<name>.evalset_result.json`, which
 * is what the two SDKs share.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {validatePathSegment} from '../artifacts/artifact_util.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {isFileNotFoundError} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';
import {EvalCaseResult} from './eval_result.js';
import {
  createEvalSetResult,
  parseEvalSetResultJson,
  serializeEvalSetResult,
} from './eval_set_result_utils.js';
import {
  EvalSetResult,
  EvalSetResultsManager,
} from './eval_set_results_manager.js';

const EVAL_HISTORY_DIR = path.join('.adk', 'eval_history');

const EVAL_SET_RESULT_FILE_EXTENSION = '.evalset_result.json';

/** Stores eval run results as files under an agents directory. */
export class LocalEvalSetResultsManager implements EvalSetResultsManager {
  constructor(private readonly agentsDir: string) {}

  async saveEvalSetResult(
    appName: string,
    evalSetId: string,
    evalCaseResults: EvalCaseResult[],
  ): Promise<void> {
    validatePathSegment(evalSetId, 'eval_set_id');
    const evalSetResult = createEvalSetResult(
      appName,
      evalSetId,
      evalCaseResults,
    );
    const historyDir = this.getEvalHistoryDir(appName);
    await fs.mkdir(historyDir, {recursive: true});
    const filePath = path.join(
      historyDir,
      evalSetResult.evalSetResultName + EVAL_SET_RESULT_FILE_EXTENSION,
    );
    logger.debug(`Writing eval result to file: ${filePath}`);
    await fs.writeFile(
      filePath,
      serializeEvalSetResult(evalSetResult),
      'utf-8',
    );
  }

  async getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult> {
    validatePathSegment(evalSetResultId, 'eval_set_result_id');
    const filePath = path.join(
      this.getEvalHistoryDir(appName),
      evalSetResultId + EVAL_SET_RESULT_FILE_EXTENSION,
    );
    try {
      return parseEvalSetResultJson(await fs.readFile(filePath, 'utf-8'));
    } catch (err: unknown) {
      if (isFileNotFoundError(err)) {
        throw new NotFoundError(
          `Eval set result \`${evalSetResultId}\` not found.`,
        );
      }
      throw err;
    }
  }

  async listEvalSetResults(appName: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.getEvalHistoryDir(appName));
    } catch (err: unknown) {
      if (isFileNotFoundError(err)) {
        return [];
      }
      throw err;
    }
    return entries
      .filter((entry) => entry.endsWith(EVAL_SET_RESULT_FILE_EXTENSION))
      .map((entry) => entry.slice(0, -EVAL_SET_RESULT_FILE_EXTENSION.length));
  }

  private getEvalHistoryDir(appName: string): string {
    validatePathSegment(appName, 'app_name');
    return path.join(this.agentsDir, appName, EVAL_HISTORY_DIR);
  }
}
