/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {EvalCaseResult, EvalSetResult} from './eval_result.js';

/**
 * An interface to manage Eval Set Results.
 */
export abstract class EvalSetResultsManager {
  /**
   * Creates and saves a new EvalSetResult given the eval case results.
   */
  abstract saveEvalSetResult(
    appName: string,
    evalSetId: string,
    evalCaseResults: EvalCaseResult[],
  ): Promise<void>;

  /**
   * Returns the EvalSetResult identified by app name and eval set result id.
   *
   * @throws {NotFoundError} If the EvalSetResult is not found.
   */
  abstract getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult>;

  /**
   * Returns the eval result ids that belong to the given app name.
   */
  abstract listEvalSetResults(appName: string): Promise<string[]>;
}
