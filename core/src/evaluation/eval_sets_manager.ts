/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {EvalCase} from './eval_case.js';
import type {EvalSet} from './eval_set.js';

/**
 * An interface to manage Eval Sets.
 */
export abstract class EvalSetsManager {
  /**
   * Returns an EvalSet identified by an app name and eval set id, or
   * `undefined` if it does not exist.
   */
  abstract getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined>;

  /**
   * Creates and returns an empty EvalSet given the app name and eval set id.
   *
   * A valid eval set id is a string of one or more lower/upper case
   * characters, digits, or underscores.
   *
   * @throws {Error} If the eval set id is not valid or an eval set already
   *     exists.
   */
  abstract createEvalSet(appName: string, evalSetId: string): Promise<EvalSet>;

  /**
   * Returns the ids of the EvalSets that belong to the given app name.
   *
   * @throws {NotFoundError} If the app name doesn't exist.
   */
  abstract listEvalSets(appName: string): Promise<string[]>;

  /**
   * Returns an EvalCase if found; otherwise, `undefined`.
   */
  abstract getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined>;

  /**
   * Adds the given EvalCase to an existing EvalSet.
   *
   * @throws {NotFoundError} If the eval set is not found.
   * @throws {Error} If the eval case already exists.
   */
  abstract addEvalCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
  ): Promise<void>;

  /**
   * Updates an existing EvalCase.
   *
   * @throws {NotFoundError} If the eval set or the eval case is not found.
   */
  abstract updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void>;

  /**
   * Deletes the EvalCase identified by app name, eval set id, and eval case id.
   *
   * @throws {NotFoundError} If the eval set or the eval case is not found.
   */
  abstract deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void>;
}
