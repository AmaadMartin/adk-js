/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalCaseResult} from './eval_result.js';

/** The results of evaluating every case in one eval set. */
export interface EvalSetResult {
  evalSetResultId: string;

  evalSetResultName?: string;

  evalSetId: string;

  evalCaseResults: EvalCaseResult[];

  /** Creation time in seconds since the epoch. */
  creationTimestamp: number;
}

/**
 * Stores the results of eval runs.
 *
 * The methods are asynchronous because an implementation can be backed by
 * remote storage; adk-python's equivalent is synchronous.
 */
export interface EvalSetResultsManager {
  /** Saves the results of one eval run. */
  saveEvalSetResult(
    appName: string,
    evalSetId: string,
    evalCaseResults: EvalCaseResult[],
  ): Promise<void>;

  /**
   * Returns a saved eval set result.
   *
   * @throws {NotFoundError} If the app has no result with that id.
   */
  getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult>;

  /** Returns the ids of every eval set result the app has. */
  listEvalSetResults(appName: string): Promise<string[]>;
}
