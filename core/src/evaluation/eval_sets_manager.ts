/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalCase} from './eval_case.js';
import {EvalSet} from './eval_set.js';

/**
 * An interface to manage Eval Sets.
 *
 * Methods are asynchronous to match adk-js service conventions
 * (`BaseSessionService`, `BaseMemoryService`, `BaseArtifactService`) and to
 * support the I/O-backed implementations (local/GCS) planned in later
 * sub-ports.
 */
export interface EvalSetsManager {
  /** Returns an eval set identified by an app name and eval set id. */
  getEvalSet(appName: string, evalSetId: string): Promise<EvalSet | undefined>;

  /**
   * Creates and returns an empty eval set given the app name and eval set id.
   *
   * @throws {Error} If the eval set id is not valid or an eval set already
   *     exists. A valid eval set id contains one or more of: lower-case
   *     characters, upper-case characters, digits (0-9), and underscores.
   */
  createEvalSet(appName: string, evalSetId: string): Promise<EvalSet>;

  /**
   * Returns the ids of the eval sets that belong to the given app name.
   *
   * @throws {Error} If the app name doesn't exist.
   */
  listEvalSets(appName: string): Promise<string[]>;

  /** Returns an eval case if found; otherwise `undefined`. */
  getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined>;

  /**
   * Adds the given eval case to an existing eval set identified by app name and
   * eval set id.
   *
   * @throws {Error} If the eval set is not found.
   */
  addEvalCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
  ): Promise<void>;

  /**
   * Updates an existing eval case given the app name and eval set id.
   *
   * @throws {Error} If the eval set or the eval case is not found.
   */
  updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void>;

  /**
   * Deletes the eval case identified by app name, eval set id and eval case id.
   *
   * @throws {Error} If the eval set or the eval case to delete is not found.
   */
  deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void>;
}
