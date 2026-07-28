/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError} from '../errors/not_found_error.js';
import {EvalCase} from './eval_case.js';
import {EvalSet} from './eval_set.js';
import {EvalSetsManager} from './eval_sets_manager.js';

/**
 * Returns an EvalSet if found; otherwise, throws {@link NotFoundError}.
 */
export async function getEvalSetFromAppAndId(
  evalSetsManager: EvalSetsManager,
  appName: string,
  evalSetId: string,
): Promise<EvalSet> {
  const evalSet = await evalSetsManager.getEvalSet(appName, evalSetId);
  if (!evalSet) {
    throw new NotFoundError(`Eval set \`${evalSetId}\` not found.`);
  }
  return evalSet;
}

/**
 * Returns an EvalCase from the eval set if found; otherwise, `undefined`.
 */
export function getEvalCaseFromEvalSet(
  evalSet: EvalSet,
  evalCaseId: string,
): EvalCase | undefined {
  return evalSet.evalCases.find((evalCase) => evalCase.evalId === evalCaseId);
}

/**
 * Adds an eval case to an eval set and returns the (mutated) eval set.
 *
 * @throws {Error} If an eval case with the same id already exists.
 */
export function addEvalCaseToEvalSet(
  evalSet: EvalSet,
  evalCase: EvalCase,
): EvalSet {
  const evalCaseId = evalCase.evalId;
  if (getEvalCaseFromEvalSet(evalSet, evalCaseId)) {
    throw new Error(
      `Eval id \`${evalCaseId}\` already exists in \`${evalSet.evalSetId}\`` +
        ` eval set.`,
    );
  }
  evalSet.evalCases.push(evalCase);
  return evalSet;
}

/**
 * Updates an eval case in an eval set and returns the (mutated) eval set.
 *
 * The existing eval case is removed and the updated eval case is appended,
 * moving it to the end of the list (parity with adk-python).
 *
 * @throws {NotFoundError} If the eval case is not found.
 */
export function updateEvalCaseInEvalSet(
  evalSet: EvalSet,
  updatedEvalCase: EvalCase,
): EvalSet {
  const evalCaseId = updatedEvalCase.evalId;
  const existing = getEvalCaseFromEvalSet(evalSet, evalCaseId);
  if (!existing) {
    throw new NotFoundError(
      `Eval case \`${evalCaseId}\` not found in eval set` +
        ` \`${evalSet.evalSetId}\`.`,
    );
  }
  evalSet.evalCases = evalSet.evalCases.filter(
    (evalCase) => evalCase.evalId !== evalCaseId,
  );
  evalSet.evalCases.push(updatedEvalCase);
  return evalSet;
}

/**
 * Deletes an eval case from an eval set and returns the (mutated) eval set.
 *
 * @throws {NotFoundError} If the eval case is not found.
 */
export function deleteEvalCaseFromEvalSet(
  evalSet: EvalSet,
  evalCaseId: string,
): EvalSet {
  if (!getEvalCaseFromEvalSet(evalSet, evalCaseId)) {
    throw new NotFoundError(
      `Eval case \`${evalCaseId}\` not found in eval set` +
        ` \`${evalSet.evalSetId}\`.`,
    );
  }
  evalSet.evalCases = evalSet.evalCases.filter(
    (evalCase) => evalCase.evalId !== evalCaseId,
  );
  return evalSet;
}
