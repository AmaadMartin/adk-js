/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCaseResult,
  EvalSetResult,
  EvalSetResultsManager,
  NotFoundError,
} from '@google/adk';

/** One call to {@link StubEvalSetResultsManager.saveEvalSetResult}. */
export interface SavedEvalSetResult {
  appName: string;
  evalSetId: string;
  evalCaseResults: EvalCaseResult[];
}

/** Records what an eval run persisted, so a test can assert the order. */
export class StubEvalSetResultsManager implements EvalSetResultsManager {
  readonly saved: SavedEvalSetResult[] = [];

  async saveEvalSetResult(
    appName: string,
    evalSetId: string,
    evalCaseResults: EvalCaseResult[],
  ): Promise<void> {
    this.saved.push({appName, evalSetId, evalCaseResults});
  }

  async getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult> {
    throw new NotFoundError(
      `No eval set result ${evalSetResultId} for app ${appName}.`,
    );
  }

  async listEvalSetResults(): Promise<string[]> {
    return [];
  }
}
