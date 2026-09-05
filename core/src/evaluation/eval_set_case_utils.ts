/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The eval-case edits shared by the eval-set managers that persist their sets.
 *
 * A stored manager reads the whole eval set, edits it, and writes it back.
 * These functions are the edit step, so that the local manager and the GCS
 * manager agree on what an edit does and on what they report when they cannot
 * make it. {@link InMemoryEvalSetsManager} holds live objects instead and
 * edits them directly.
 */

import {AlreadyExistsError} from '../errors/already_exists_error.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {EvalCase} from './eval_case.js';
import {EvalSet} from './eval_set.js';
import {EvalSetsManager} from './eval_sets_manager.js';

/** The characters an eval set id may hold, as adk-python spells the rule. */
const EVAL_SET_ID_PATTERN = '^[a-zA-Z0-9_]+$';

/**
 * Rejects an id a manager cannot store.
 *
 * @throws {InputValidationError} When the id holds anything but letters,
 *   digits and underscores.
 */
export function validateEvalSetId(evalSetId: string): void {
  if (!new RegExp(EVAL_SET_ID_PATTERN).test(evalSetId)) {
    throw new InputValidationError(
      `Invalid Eval Set ID. Eval Set ID should have the ` +
        `\`${EVAL_SET_ID_PATTERN}\` format`,
    );
  }
}

/** Returns the eval case with that id, or undefined when the set has none. */
export function getEvalCaseFromEvalSet(
  evalSet: EvalSet,
  evalCaseId: string,
): EvalCase | undefined {
  return evalSet.evalCases.find((evalCase) => evalCase.evalId === evalCaseId);
}

/**
 * Returns the eval set the manager holds under that id.
 *
 * @throws {NotFoundError} When the app has no such eval set.
 */
export async function requireEvalSet(
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
 * Appends an eval case to an eval set and returns the edited set.
 *
 * @throws {AlreadyExistsError} When the set already holds that eval case.
 */
export function addEvalCaseToEvalSet(
  evalSet: EvalSet,
  evalCase: EvalCase,
): EvalSet {
  if (getEvalCaseFromEvalSet(evalSet, evalCase.evalId)) {
    throw new AlreadyExistsError(
      `Eval id \`${evalCase.evalId}\` already exists in ` +
        `\`${evalSet.evalSetId}\` eval set.`,
    );
  }
  evalSet.evalCases.push(evalCase);
  return evalSet;
}

/**
 * Replaces an eval case in an eval set and returns the edited set.
 *
 * The replacement is appended, matching adk-python, so the case order after an
 * update is not the order the cases were created in.
 *
 * @throws {NotFoundError} When the set does not hold that eval case.
 */
export function updateEvalCaseInEvalSet(
  evalSet: EvalSet,
  updatedEvalCase: EvalCase,
): EvalSet {
  const index = indexOfEvalCase(evalSet, updatedEvalCase.evalId);
  evalSet.evalCases.splice(index, 1);
  evalSet.evalCases.push(updatedEvalCase);
  return evalSet;
}

/**
 * Removes an eval case from an eval set and returns the edited set.
 *
 * @throws {NotFoundError} When the set does not hold that eval case.
 */
export function deleteEvalCaseFromEvalSet(
  evalSet: EvalSet,
  evalCaseId: string,
): EvalSet {
  evalSet.evalCases.splice(indexOfEvalCase(evalSet, evalCaseId), 1);
  return evalSet;
}

/**
 * Returns where the eval case sits in the set.
 *
 * @throws {NotFoundError} When the set does not hold it.
 */
function indexOfEvalCase(evalSet: EvalSet, evalCaseId: string): number {
  const index = evalSet.evalCases.findIndex(
    (evalCase) => evalCase.evalId === evalCaseId,
  );
  if (index < 0) {
    throw new NotFoundError(
      `Eval case \`${evalCaseId}\` not found in eval set ` +
        `\`${evalSet.evalSetId}\`.`,
    );
  }
  return index;
}
