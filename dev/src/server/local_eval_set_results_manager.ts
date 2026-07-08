/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {EvalCaseResult, EvalSetResult} from './evaluation_types.js';
import {NotFoundError, validatePathSegment} from './local_eval_sets_manager.js';

const ADK_EVAL_HISTORY_DIR = '.adk/eval_history';
const EVAL_SET_RESULT_FILE_EXTENSION = '.evalset_result.json';

function createEvalSetResult(
  appName: string,
  evalSetId: string,
  evalCaseResults: EvalCaseResult[],
): EvalSetResult {
  const timestamp = Date.now() / 1000;
  const evalSetResultId = `${appName}_${evalSetId}_${timestamp}`;
  return {
    evalSetResultId,
    evalSetResultName: evalSetResultId,
    evalSetId,
    evalCaseResults,
    creationTimestamp: timestamp,
  };
}

function parseEvalSetResultJson(content: string): EvalSetResult {
  const parsed = JSON.parse(content);
  if (typeof parsed === 'string') {
    return JSON.parse(parsed) as EvalSetResult;
  }
  return parsed as EvalSetResult;
}

export class LocalEvalSetResultsManager {
  constructor(private readonly agentsDir: string) {}

  private getEvalHistoryDir(appName: string): string {
    validatePathSegment(appName, 'appName');
    return path.join(this.agentsDir, appName, ADK_EVAL_HISTORY_DIR);
  }

  async saveEvalSetResult(
    appName: string,
    evalSetId: string,
    evalCaseResults: EvalCaseResult[],
  ): Promise<EvalSetResult> {
    validatePathSegment(appName, 'appName');
    validatePathSegment(evalSetId, 'evalSetId');

    const evalSetResult = createEvalSetResult(
      appName,
      evalSetId,
      evalCaseResults,
    );
    const historyDir = this.getEvalHistoryDir(appName);
    await fsPromises.mkdir(historyDir, {recursive: true});

    const filePath = path.join(
      historyDir,
      evalSetResult.evalSetResultName + EVAL_SET_RESULT_FILE_EXTENSION,
    );

    await fsPromises.writeFile(
      filePath,
      JSON.stringify(evalSetResult, null, 2),
      'utf-8',
    );
    return evalSetResult;
  }

  async getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult> {
    validatePathSegment(evalSetResultId, 'evalSetResultId');
    const historyDir = this.getEvalHistoryDir(appName);
    const filePath = path.join(
      historyDir,
      evalSetResultId + EVAL_SET_RESULT_FILE_EXTENSION,
    );

    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return parseEvalSetResultJson(content);
    } catch (e: unknown) {
      if ((e as {code?: string}).code === 'ENOENT') {
        throw new NotFoundError(
          `Eval set result "${evalSetResultId}" not found.`,
        );
      }
      throw e;
    }
  }

  async listEvalSetResults(appName: string): Promise<string[]> {
    const historyDir = this.getEvalHistoryDir(appName);
    try {
      const files = await fsPromises.readdir(historyDir);
      const results = files
        .filter((file) => file.endsWith(EVAL_SET_RESULT_FILE_EXTENSION))
        .map((file) => path.basename(file, EVAL_SET_RESULT_FILE_EXTENSION));
      return results.sort();
    } catch (e: unknown) {
      if ((e as {code?: string}).code === 'ENOENT') {
        return [];
      }
      throw e;
    }
  }
}
