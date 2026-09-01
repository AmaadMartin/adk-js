/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalCase} from './eval_case.js';
import {EvalSet} from './eval_set.js';

/**
 * Stores the eval sets of an app.
 *
 * The methods are asynchronous because an implementation can be backed by
 * remote storage; adk-python's equivalent is synchronous.
 */
export interface EvalSetsManager {
  /** Returns the eval set, or undefined when the app has no such set. */
  getEvalSet(appName: string, evalSetId: string): Promise<EvalSet | undefined>;

  /**
   * Creates an empty eval set.
   *
   * @throws {AlreadyExistsError} If the app already has a set with that id.
   */
  createEvalSet(appName: string, evalSetId: string): Promise<EvalSet>;

  /** Returns the ids of every eval set the app has. */
  listEvalSets(appName: string): Promise<string[]>;

  /** Returns the eval case, or undefined when it is not in the set. */
  getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined>;

  /**
   * Adds an eval case to an eval set.
   *
   * @throws {NotFoundError} If the eval set does not exist.
   * @throws {AlreadyExistsError} If the set already holds that eval case.
   */
  addEvalCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
  ): Promise<void>;

  /**
   * Replaces an eval case.
   *
   * @throws {NotFoundError} If the eval set or the eval case does not exist.
   */
  updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void>;

  /**
   * Removes an eval case from an eval set.
   *
   * @throws {NotFoundError} If the eval set or the eval case does not exist.
   */
  deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void>;
}
