/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalCaseResult, EvalSetResult} from './eval_result.js';

/**
 * An interface to manage Eval Set Results.
 *
 * Methods are asynchronous to match adk-js service conventions
 * (`BaseSessionService`, `BaseMemoryService`, `BaseArtifactService`) and to
 * support the I/O-backed implementations (local/GCS) planned in later
 * sub-ports.
 */
export interface EvalSetResultsManager {
  /** Creates and saves a new eval set result from the given case results. */
  saveEvalSetResult(
    appName: string,
    evalSetId: string,
    evalCaseResults: EvalCaseResult[],
  ): Promise<void>;

  /**
   * Returns the eval set result for the given app name and eval set result id.
   *
   * @throws {Error} If the eval set result is not found.
   */
  getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult>;

  /** Returns the eval set result ids that belong to the given app name. */
  listEvalSetResults(appName: string): Promise<string[]>;
}
