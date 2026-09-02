/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eval sets stored in a Google Cloud Storage bucket.
 *
 * A port of adk-python's
 * `src/google/adk/evaluation/gcs_eval_sets_manager.py`. The blob layout is
 * `<appName>/evals/eval_sets/<evalSetId>.evalset.json`, which is what the two
 * SDKs share.
 */

import type {StorageOptions} from '@google-cloud/storage';
import {validatePathSegment} from '../artifacts/artifact_util.js';
import {AlreadyExistsError} from '../errors/already_exists_error.js';
import {EvalCase} from './eval_case.js';
import {parseEvalSet, serializeEvalSet} from './eval_json.js';
import {EvalSet} from './eval_set.js';
import {
  addEvalCaseToEvalSet,
  deleteEvalCaseFromEvalSet,
  getEvalCaseFromEvalSet,
  requireEvalSet,
  updateEvalCaseInEvalSet,
  validateEvalSetId,
} from './eval_set_case_utils.js';
import {EvalSetsManager} from './eval_sets_manager.js';
import {blobIdFromName, GcsEvalStorage} from './gcs_eval_storage.js';

/** Milliseconds per second, for the epoch-seconds timestamps eval data uses. */
const MILLIS_PER_SECOND = 1000;

const EVAL_SETS_DIR = 'evals/eval_sets';

const EVAL_SET_FILE_EXTENSION = '.evalset.json';

/** Stores eval sets as blobs in a GCS bucket. */
export class GcsEvalSetsManager implements EvalSetsManager {
  private readonly storage: GcsEvalStorage;

  constructor(bucketName: string, storageOptions?: StorageOptions) {
    this.storage = new GcsEvalStorage(
      bucketName,
      'GcsEvalSetsManager',
      storageOptions,
    );
  }

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    const contents = await this.storage.read(
      getEvalSetBlobName(appName, evalSetId),
    );
    return contents === undefined
      ? undefined
      : parseEvalSet(JSON.parse(contents));
  }

  async createEvalSet(appName: string, evalSetId: string): Promise<EvalSet> {
    validateEvalSetId(evalSetId);
    const blobName = getEvalSetBlobName(appName, evalSetId);
    if ((await this.storage.read(blobName)) !== undefined) {
      throw new AlreadyExistsError(
        `EvalSet ${evalSetId} already exists for app ${appName}.`,
      );
    }
    const evalSet: EvalSet = {
      evalSetId,
      name: evalSetId,
      evalCases: [],
      creationTimestamp: Date.now() / MILLIS_PER_SECOND,
    };
    await this.storage.write(blobName, serializeEvalSet(evalSet));
    return evalSet;
  }

  async listEvalSets(appName: string): Promise<string[]> {
    const names = await this.storage.listNames(getEvalSetsDir(appName));
    return names
      .filter((name) => name.endsWith(EVAL_SET_FILE_EXTENSION))
      .map((name) => blobIdFromName(name, EVAL_SET_FILE_EXTENSION))
      .sort();
  }

  async getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined> {
    const evalSet = await this.getEvalSet(appName, evalSetId);
    return evalSet && getEvalCaseFromEvalSet(evalSet, evalCaseId);
  }

  async addEvalCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
  ): Promise<void> {
    const evalSet = await requireEvalSet(this, appName, evalSetId);
    await this.saveEvalSet(
      appName,
      evalSetId,
      addEvalCaseToEvalSet(evalSet, evalCase),
    );
  }

  async updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void> {
    const evalSet = await requireEvalSet(this, appName, evalSetId);
    await this.saveEvalSet(
      appName,
      evalSetId,
      updateEvalCaseInEvalSet(evalSet, updatedEvalCase),
    );
  }

  async deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void> {
    const evalSet = await requireEvalSet(this, appName, evalSetId);
    await this.saveEvalSet(
      appName,
      evalSetId,
      deleteEvalCaseFromEvalSet(evalSet, evalCaseId),
    );
  }

  private async saveEvalSet(
    appName: string,
    evalSetId: string,
    evalSet: EvalSet,
  ): Promise<void> {
    await this.storage.write(
      getEvalSetBlobName(appName, evalSetId),
      serializeEvalSet(evalSet),
    );
  }
}

function getEvalSetsDir(appName: string): string {
  validatePathSegment(appName, 'app_name');
  return `${appName}/${EVAL_SETS_DIR}`;
}

function getEvalSetBlobName(appName: string, evalSetId: string): string {
  validatePathSegment(evalSetId, 'eval_set_id');
  return `${getEvalSetsDir(appName)}/${evalSetId}${EVAL_SET_FILE_EXTENSION}`;
}
