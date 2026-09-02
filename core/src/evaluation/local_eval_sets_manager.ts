/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eval sets stored on the local file system, under the agents directory.
 *
 * A port of adk-python's
 * `src/google/adk/evaluation/local_eval_sets_manager.py`. The on-disk layout is
 * `<agentsDir>/<appName>/<evalSetId>.evalset.json`, which is what the two SDKs
 * share, so a set written by either of them is readable by the other.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {validatePathSegment} from '../artifacts/artifact_util.js';
import {AlreadyExistsError} from '../errors/already_exists_error.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {isFileNotFoundError} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';
import {EvalCase} from './eval_case.js';
import {
  EvalSetSchemaError,
  parseEvalSet,
  serializeEvalSet,
} from './eval_json.js';
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
import {
  convertLegacyEvalSet,
  parseLegacyEvalCases,
} from './legacy_eval_set_converter.js';

/** Milliseconds per second, for the epoch-seconds timestamps eval data uses. */
const MILLIS_PER_SECOND = 1000;

const EVAL_SET_FILE_EXTENSION = '.evalset.json';

/**
 * Reads an eval set from a file, falling back to ADK's original format when
 * the file does not hold the current schema.
 *
 * A file that is not valid JSON surfaces its parse error rather than being
 * read as data in the original format.
 *
 * @param evalSetFilePath The file to read.
 * @param evalSetId The id to give a set read from the original format, which
 *   does not record one.
 */
export async function loadEvalSetFromFile(
  evalSetFilePath: string,
  evalSetId: string,
): Promise<EvalSet> {
  const raw: unknown = JSON.parse(await fs.readFile(evalSetFilePath, 'utf-8'));
  try {
    return parseEvalSet(raw);
  } catch (err: unknown) {
    if (!(err instanceof EvalSetSchemaError)) {
      throw err;
    }
    logger.debug(
      `Contents of ${evalSetFilePath} appear to be in the older format.`,
    );
    return convertLegacyEvalSet(evalSetId, parseLegacyEvalCases(raw));
  }
}

/** Stores eval sets as files under an agents directory. */
export class LocalEvalSetsManager implements EvalSetsManager {
  constructor(private readonly agentsDir: string) {}

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    const filePath = this.getEvalSetFilePath(appName, evalSetId);
    try {
      return await loadEvalSetFromFile(filePath, evalSetId);
    } catch (err: unknown) {
      if (isFileNotFoundError(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async createEvalSet(appName: string, evalSetId: string): Promise<EvalSet> {
    validateEvalSetId(evalSetId);
    const filePath = this.getEvalSetFilePath(appName, evalSetId);
    const evalSet: EvalSet = {
      evalSetId,
      name: evalSetId,
      evalCases: [],
      creationTimestamp: Date.now() / MILLIS_PER_SECOND,
    };
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    try {
      // `wx` fails when the file is already there, so a concurrent create
      // cannot silently discard the set the other caller wrote.
      await fs.writeFile(filePath, serializeEvalSet(evalSet), {
        encoding: 'utf-8',
        flag: 'wx',
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err as {code?: string}).code === 'EEXIST') {
        throw new AlreadyExistsError(
          `EvalSet ${evalSetId} already exists for app ${appName}.`,
        );
      }
      throw err;
    }
    return evalSet;
  }

  async listEvalSets(appName: string): Promise<string[]> {
    validatePathSegment(appName, 'app_name');
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(this.agentsDir, appName));
    } catch (err: unknown) {
      if (isFileNotFoundError(err)) {
        throw new NotFoundError(
          `Eval directory for app \`${appName}\` not found.`,
        );
      }
      throw err;
    }
    return entries
      .filter((entry) => entry.endsWith(EVAL_SET_FILE_EXTENSION))
      .map((entry) => entry.slice(0, -EVAL_SET_FILE_EXTENSION.length))
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

  private getEvalSetFilePath(appName: string, evalSetId: string): string {
    validatePathSegment(appName, 'app_name');
    validatePathSegment(evalSetId, 'eval_set_id');
    return path.join(
      this.agentsDir,
      appName,
      evalSetId + EVAL_SET_FILE_EXTENSION,
    );
  }

  private async saveEvalSet(
    appName: string,
    evalSetId: string,
    evalSet: EvalSet,
  ): Promise<void> {
    const filePath = this.getEvalSetFilePath(appName, evalSetId);
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, serializeEvalSet(evalSet), 'utf-8');
  }
}
