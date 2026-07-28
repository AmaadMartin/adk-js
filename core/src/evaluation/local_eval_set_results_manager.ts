/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import {NotFoundError} from '../errors/not_found_error.js';
import {toSnakeCase} from '../utils/object_notation_utils.js';
import {EvalCaseResult, EvalSetResult} from './eval_result.js';
import {EvalSetResultsManager} from './eval_set_results_manager.js';
import {
  EVAL_SET_RESULT_PRESERVE_KEYS_CAMEL_CASE,
  createEvalSetResult,
  parseEvalSetResultJson,
} from './eval_set_results_manager_utils.js';
import {isFileNotFoundError} from './fs_utils.js';
import {validatePathSegment} from './path_validation.js';

/**
 * Directory (relative to an app dir) where eval set results are stored.
 */
export const ADK_EVAL_HISTORY_DIR = '.adk/eval_history';

/**
 * File extension used for locally-stored eval set results.
 */
export const EVAL_SET_RESULT_FILE_EXTENSION = '.evalset_result.json';

/**
 * An {@link EvalSetResultsManager} that stores eval set results locally on disk.
 */
export class LocalEvalSetResultsManager extends EvalSetResultsManager {
  constructor(private readonly agentsDir: string) {
    super();
  }

  async saveEvalSetResult(
    appName: string,
    evalSetId: string,
    evalCaseResults: EvalCaseResult[],
  ): Promise<void> {
    validatePathSegment(appName, 'app_name');
    validatePathSegment(evalSetId, 'eval_set_id');
    const evalSetResult = createEvalSetResult(
      appName,
      evalSetId,
      evalCaseResults,
    );

    const appEvalHistoryDir = this.getEvalHistoryDir(appName);
    await fs.mkdir(appEvalHistoryDir, {recursive: true});

    const evalSetResultFilePath = path.join(
      appEvalHistoryDir,
      evalSetResult.evalSetResultName + EVAL_SET_RESULT_FILE_EXTENSION,
    );
    await fs.writeFile(
      evalSetResultFilePath,
      JSON.stringify(
        toSnakeCase(evalSetResult, EVAL_SET_RESULT_PRESERVE_KEYS_CAMEL_CASE),
        null,
        2,
      ),
      'utf-8',
    );
  }

  async getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult> {
    validatePathSegment(evalSetResultId, 'eval_set_result_id');
    const evalResultFilePath =
      path.join(this.getEvalHistoryDir(appName), evalSetResultId) +
      EVAL_SET_RESULT_FILE_EXTENSION;

    let content: string;
    try {
      content = await fs.readFile(evalResultFilePath, 'utf-8');
    } catch (error) {
      if (isFileNotFoundError(error)) {
        throw new NotFoundError(
          `Eval set result \`${evalSetResultId}\` not found.`,
        );
      }
      throw error;
    }
    return parseEvalSetResultJson(content);
  }

  async listEvalSetResults(appName: string): Promise<string[]> {
    const appEvalHistoryDir = this.getEvalHistoryDir(appName);
    let files: string[];
    try {
      files = await fs.readdir(appEvalHistoryDir);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return [];
      }
      throw error;
    }
    return files
      .filter((file) => file.endsWith(EVAL_SET_RESULT_FILE_EXTENSION))
      .map((file) => file.slice(0, -EVAL_SET_RESULT_FILE_EXTENSION.length));
  }

  private getEvalHistoryDir(appName: string): string {
    validatePathSegment(appName, 'app_name');
    return path.join(this.agentsDir, appName, ADK_EVAL_HISTORY_DIR);
  }
}
