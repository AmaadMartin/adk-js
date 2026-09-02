/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eval run results stored in a Google Cloud Storage bucket.
 *
 * A port of adk-python's
 * `src/google/adk/evaluation/gcs_eval_set_results_manager.py`. The blob layout
 * is `<appName>/evals/eval_history/<id>.evalset_result.json`, which is what
 * the two SDKs share.
 */

import type {StorageOptions} from '@google-cloud/storage';
import {validatePathSegment} from '../artifacts/artifact_util.js';
import {NotFoundError} from '../errors/not_found_error.js';
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
import {blobIdFromName, GcsEvalStorage} from './gcs_eval_storage.js';

const EVAL_HISTORY_DIR = 'evals/eval_history';

const EVAL_SET_RESULT_FILE_EXTENSION = '.evalset_result.json';

/** Stores eval run results as blobs in a GCS bucket. */
export class GcsEvalSetResultsManager implements EvalSetResultsManager {
  private readonly storage: GcsEvalStorage;

  constructor(bucketName: string, storageOptions?: StorageOptions) {
    this.storage = new GcsEvalStorage(
      bucketName,
      'GcsEvalSetResultsManager',
      storageOptions,
    );
  }

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
    const blobName = getEvalSetResultBlobName(
      appName,
      evalSetResult.evalSetResultName,
    );
    logger.debug(`Writing eval result to blob: ${blobName}`);
    await this.storage.write(blobName, serializeEvalSetResult(evalSetResult));
  }

  async getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult> {
    const contents = await this.storage.read(
      getEvalSetResultBlobName(appName, evalSetResultId),
    );
    if (contents === undefined) {
      throw new NotFoundError(
        `Eval set result \`${evalSetResultId}\` not found.`,
      );
    }
    return parseEvalSetResultJson(contents);
  }

  async listEvalSetResults(appName: string): Promise<string[]> {
    const names = await this.storage.listNames(getEvalHistoryDir(appName));
    return names
      .filter((name) => name.endsWith(EVAL_SET_RESULT_FILE_EXTENSION))
      .map((name) => blobIdFromName(name, EVAL_SET_RESULT_FILE_EXTENSION))
      .sort();
  }
}

function getEvalHistoryDir(appName: string): string {
  validatePathSegment(appName, 'app_name');
  return `${appName}/${EVAL_HISTORY_DIR}`;
}

function getEvalSetResultBlobName(
  appName: string,
  evalSetResultId: string,
): string {
  validatePathSegment(evalSetResultId, 'eval_set_result_id');
  return (
    `${getEvalHistoryDir(appName)}/` +
    `${evalSetResultId}${EVAL_SET_RESULT_FILE_EXTENSION}`
  );
}
