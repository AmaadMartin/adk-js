/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AlreadyExistsError} from '../errors/already_exists_error.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {nowInSeconds} from '../utils/time_utils.js';
import {EvalCase} from './eval_case.js';
import {EvalSet} from './eval_set.js';
import {EvalSetsManager} from './eval_sets_manager.js';

/**
 * Holds eval sets in memory.
 *
 * Use it from a test, or wherever a persistent implementation would cost more
 * than it is worth.
 */
export class InMemoryEvalSetsManager implements EvalSetsManager {
  /** App name to eval set id to eval set. */
  private readonly evalSets = new Map<string, Map<string, EvalSet>>();

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    return this.evalSets.get(appName)?.get(evalSetId);
  }

  async createEvalSet(appName: string, evalSetId: string): Promise<EvalSet> {
    const setsForApp = this.setsForApp(appName);
    if (setsForApp.has(evalSetId)) {
      throw new AlreadyExistsError(
        `EvalSet ${evalSetId} already exists for app ${appName}.`,
      );
    }
    const evalSet: EvalSet = {
      evalSetId,
      evalCases: [],
      creationTimestamp: nowInSeconds(),
    };
    setsForApp.set(evalSetId, evalSet);
    return evalSet;
  }

  async listEvalSets(appName: string): Promise<string[]> {
    return [...(this.evalSets.get(appName)?.keys() ?? [])];
  }

  async getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined> {
    const evalSet = await this.getEvalSet(appName, evalSetId);
    return evalSet?.evalCases.find(
      (evalCase) => evalCase.evalId === evalCaseId,
    );
  }

  async addEvalCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
  ): Promise<void> {
    const evalSet = this.requireEvalSet(appName, evalSetId);
    if (evalSet.evalCases.some((known) => known.evalId === evalCase.evalId)) {
      throw new AlreadyExistsError(
        `EvalCase ${evalCase.evalId} already exists in EvalSet ${evalSetId} ` +
          `for app ${appName}.`,
      );
    }
    evalSet.evalCases.push(evalCase);
  }

  async updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void> {
    const evalSet = this.requireEvalSet(appName, evalSetId);
    const index = evalSet.evalCases.findIndex(
      (known) => known.evalId === updatedEvalCase.evalId,
    );
    if (index < 0) {
      throw new NotFoundError(
        `EvalCase ${updatedEvalCase.evalId} not found in EvalSet ` +
          `${evalSetId} for app ${appName}.`,
      );
    }
    evalSet.evalCases[index] = updatedEvalCase;
  }

  async deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void> {
    const evalSet = this.requireEvalSet(appName, evalSetId);
    const index = evalSet.evalCases.findIndex(
      (known) => known.evalId === evalCaseId,
    );
    if (index < 0) {
      throw new NotFoundError(
        `EvalCase ${evalCaseId} not found in EvalSet ${evalSetId} for app ` +
          `${appName}.`,
      );
    }
    evalSet.evalCases.splice(index, 1);
  }

  private setsForApp(appName: string): Map<string, EvalSet> {
    let setsForApp = this.evalSets.get(appName);
    if (!setsForApp) {
      setsForApp = new Map<string, EvalSet>();
      this.evalSets.set(appName, setsForApp);
    }
    return setsForApp;
  }

  private requireEvalSet(appName: string, evalSetId: string): EvalSet {
    const evalSet = this.evalSets.get(appName)?.get(evalSetId);
    if (!evalSet) {
      throw new NotFoundError(
        `EvalSet ${evalSetId} not found for app ${appName}.`,
      );
    }
    return evalSet;
  }
}
