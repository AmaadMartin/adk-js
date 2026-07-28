/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError} from '../errors/not_found_error.js';
import {nowSeconds} from '../utils/env_aware_utils.js';
import {EvalCase} from './eval_case.js';
import {EvalSet} from './eval_set.js';
import {EvalSetsManager} from './eval_sets_manager.js';

/**
 * An in-memory implementation of {@link EvalSetsManager} backed by records.
 *
 * Use this class:
 * 1. As part of your test cases.
 * 2. For cases where other implementations of EvalSetsManager are too expensive
 *    to use.
 */
export class InMemoryEvalSetsManager extends EvalSetsManager {
  // {appName: {evalSetId: EvalSet}}
  private readonly evalSets: Record<string, Record<string, EvalSet>> = {};
  // {appName: {evalSetId: {evalCaseId: EvalCase}}}
  private readonly evalCases: Record<
    string,
    Record<string, Record<string, EvalCase>>
  > = {};

  private ensureAppExists(appName: string): void {
    if (!(appName in this.evalSets)) {
      this.evalSets[appName] = {};
      this.evalCases[appName] = {};
    }
  }

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    this.ensureAppExists(appName);
    return this.evalSets[appName][evalSetId];
  }

  async createEvalSet(appName: string, evalSetId: string): Promise<EvalSet> {
    this.ensureAppExists(appName);
    if (evalSetId in this.evalSets[appName]) {
      throw new Error(
        `EvalSet ${evalSetId} already exists for app ${appName}.`,
      );
    }

    const newEvalSet: EvalSet = {
      evalSetId,
      evalCases: [],
      creationTimestamp: nowSeconds(),
    };
    this.evalSets[appName][evalSetId] = newEvalSet;
    this.evalCases[appName][evalSetId] = {};
    return newEvalSet;
  }

  async listEvalSets(appName: string): Promise<string[]> {
    if (!(appName in this.evalSets)) {
      return [];
    }
    return Object.keys(this.evalSets[appName]);
  }

  async getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined> {
    if (!(appName in this.evalCases)) {
      return undefined;
    }
    if (!(evalSetId in this.evalCases[appName])) {
      return undefined;
    }
    return this.evalCases[appName][evalSetId][evalCaseId];
  }

  async addEvalCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
  ): Promise<void> {
    this.ensureAppExists(appName);
    if (!(evalSetId in this.evalSets[appName])) {
      throw new NotFoundError(
        `EvalSet ${evalSetId} not found for app ${appName}.`,
      );
    }
    if (evalCase.evalId in this.evalCases[appName][evalSetId]) {
      throw new Error(
        `EvalCase ${evalCase.evalId} already exists in EvalSet ${evalSetId}` +
          ` for app ${appName}.`,
      );
    }

    this.evalCases[appName][evalSetId][evalCase.evalId] = evalCase;
    // Also update the list in the EvalSet object.
    this.evalSets[appName][evalSetId].evalCases.push(evalCase);
  }

  async updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void> {
    this.ensureAppExists(appName);
    if (!(evalSetId in this.evalSets[appName])) {
      throw new NotFoundError(
        `EvalSet ${evalSetId} not found for app ${appName}.`,
      );
    }
    if (!(updatedEvalCase.evalId in this.evalCases[appName][evalSetId])) {
      throw new NotFoundError(
        `EvalCase ${updatedEvalCase.evalId} not found in EvalSet` +
          ` ${evalSetId} for app ${appName}.`,
      );
    }

    // Full replace in the case map.
    this.evalCases[appName][evalSetId][updatedEvalCase.evalId] =
      updatedEvalCase;

    // Update the list in the EvalSet object in place, preserving order.
    const evalSet = this.evalSets[appName][evalSetId];
    const index = evalSet.evalCases.findIndex(
      (evalCase) => evalCase.evalId === updatedEvalCase.evalId,
    );
    if (index !== -1) {
      evalSet.evalCases[index] = updatedEvalCase;
    }
  }

  async deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void> {
    this.ensureAppExists(appName);
    if (!(evalSetId in this.evalSets[appName])) {
      throw new NotFoundError(
        `EvalSet ${evalSetId} not found for app ${appName}.`,
      );
    }
    if (!(evalCaseId in this.evalCases[appName][evalSetId])) {
      throw new NotFoundError(
        `EvalCase ${evalCaseId} not found in EvalSet ${evalSetId}` +
          ` for app ${appName}.`,
      );
    }

    delete this.evalCases[appName][evalSetId][evalCaseId];

    // Remove from the list in the EvalSet object.
    const evalSet = this.evalSets[appName][evalSetId];
    evalSet.evalCases = evalSet.evalCases.filter(
      (evalCase) => evalCase.evalId !== evalCaseId,
    );
  }
}
